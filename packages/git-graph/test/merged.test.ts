import { describe, expect, it } from 'vitest';
import { buildSnapshot, detectMerged, needsContentCheck, prMerge, type PrRecord } from '../src';
import { commits, dag } from './helpers';

// main: m1 ← m2 ← sq (squash of f1+f2) ;  f: m1 ← f1 ← f2 ← f3 (moved after the PR)
const g = dag('m1', 'f1:m1', 'f2:f1', 'm2:m1', 'sq:m2', 'f3:f2', 'mm:m2,f2');
const main = { name: 'main', headSha: 'sq' };
const merged: PrRecord = {
  number: 7,
  headRef: 'f',
  baseRef: 'main',
  state: 'merged',
  headSha: 'f2',
  mergeMethod: 'squash',
  mergeCommitSha: 'sq',
};

describe('prMerge', () => {
  it('takes the newest merged PR and counts commits after its head', () => {
    const older = { ...merged, number: 3, headSha: 'f1' };
    expect(prMerge(g, { name: 'f', headSha: 'f3' }, [merged, older])).toEqual({
      pr: merged,
      newCommits: 1,
    });
  });
  it('ignores open/closed PRs and unknown head SHAs', () => {
    expect(prMerge(g, { name: 'f', headSha: 'f2' }, [{ ...merged, state: 'open' }])).toBeNull();
    expect(prMerge(g, { name: 'f', headSha: 'f3' }, [{ ...merged, headSha: 'zz' }])).toBeNull();
  });
});

describe('detectMerged', () => {
  it('rule 1: via pr, with method and mergeCommitSha from the PR record', () => {
    expect(
      detectMerged({ graph: g, branch: { name: 'f', headSha: 'f2' }, target: main, prs: [merged] }),
    ).toEqual({
      via: 'pr',
      prNumber: 7,
      method: 'squash',
      into: 'main',
      newCommits: 0,
      mergeCommitSha: 'sq',
    });
  });
  it('rule 1: newCommits when the branch moved past the PR head', () => {
    const m = detectMerged({
      graph: g,
      branch: { name: 'f', headSha: 'f3' },
      target: main,
      prs: [merged],
    });
    expect(m?.newCommits).toBe(1);
  });
  it('rule 1 wins over content facts', () => {
    const m = detectMerged({
      graph: g,
      branch: { name: 'f', headSha: 'f2' },
      target: main,
      prs: [merged],
      content: { patchMatched: [], mergeTreeEqualsTarget: true },
    });
    expect(m?.via).toBe('pr');
  });
  it('rule 2: content in target → squashed; all patch matches → rebased', () => {
    const f = { name: 'f', headSha: 'f2' };
    expect(
      detectMerged({
        graph: g,
        branch: f,
        target: main,
        prs: [],
        content: { patchMatched: [], mergeTreeEqualsTarget: true },
      }),
    ).toEqual({
      via: 'squashed',
      prNumber: null,
      method: null,
      into: 'main',
      newCommits: 0,
      mergeCommitSha: null,
    });
    expect(
      detectMerged({
        graph: g,
        branch: f,
        target: main,
        prs: [],
        content: { patchMatched: ['f1', 'f2'], mergeTreeEqualsTarget: false },
      })?.via,
    ).toBe('rebased');
  });
  it('rule 2: partial patch match without content → null; no facts → null', () => {
    const f = { name: 'f', headSha: 'f2' };
    expect(
      detectMerged({
        graph: g,
        branch: f,
        target: main,
        prs: [],
        content: { patchMatched: ['f1'], mergeTreeEqualsTarget: false },
      }),
    ).toBeNull();
    expect(detectMerged({ graph: g, branch: f, target: main, prs: [] })).toBeNull();
  });
  it('nothing ahead (merged with a merge commit, no PR) → null; default branch → null', () => {
    const mm = { name: 'main', headSha: 'mm' };
    const content = { patchMatched: [], mergeTreeEqualsTarget: true };
    expect(
      detectMerged({
        graph: g,
        branch: { name: 'f', headSha: 'f2' },
        target: mm,
        prs: [],
        content,
      }),
    ).toBeNull();
    expect(
      detectMerged({ graph: g, branch: main, target: null, prs: [merged], content }),
    ).toBeNull();
  });
});

describe('needsContentCheck', () => {
  it('only branches with no merged PR and commits ahead', () => {
    expect(needsContentCheck(g, { name: 'f', headSha: 'f2' }, main, [merged])).toBe(false);
    expect(needsContentCheck(g, { name: 'f', headSha: 'f2' }, main, [])).toBe(true);
    expect(
      needsContentCheck(g, { name: 'f', headSha: 'f2' }, { name: 'x', headSha: 'mm' }, []),
    ).toBe(false);
    expect(needsContentCheck(g, main, null, [])).toBe(false);
  });
});

describe('buildSnapshot + content facts', () => {
  it('marks the branch from the content facts and fills mergeCommitSha from the PR record', () => {
    const input = {
      defaultBranch: 'main',
      branches: [
        { name: 'main', headSha: 'sq' },
        { name: 'f', headSha: 'f2' },
        { name: 'g', headSha: 'f3' },
      ],
      graph: commits('m1', 'f1:m1', 'f2:f1', 'm2:m1', 'sq:m2', 'f3:f2'),
      overrides: { g: 'main' },
    };
    const snap = buildSnapshot({
      ...input,
      content: { f: { patchMatched: [], mergeTreeEqualsTarget: true } },
    });
    expect(snap.branches.find((b) => b.name === 'f')?.merged?.via).toBe('squashed');
    expect(snap.branches.find((b) => b.name === 'g')?.merged).toBeNull();

    const withPr = buildSnapshot({ ...input, prs: [merged] });
    expect(withPr.branches.find((b) => b.name === 'f')?.merged?.mergeCommitSha).toBe('sq');
  });
});

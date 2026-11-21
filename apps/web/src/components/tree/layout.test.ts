import { describe, expect, it } from 'vitest';
import { seedBranches, seedSnapshot, SEED_SHA } from './__fixtures__/seed-snapshot';
import {
  branchOrder,
  depthOf,
  layoutTree,
  MAX_SHOWN,
  mergeNote,
  subLine,
  TreeGraph,
} from './layout';

const byName = (s = seedSnapshot()) => new Map(s.branches.map((b) => [b.name, b]));

describe('branchOrder (prototype)', () => {
  it('default first, then compare-with children depth-first by name', () => {
    expect(branchOrder(seedSnapshot()).map((b) => b.name)).toEqual([
      'main',
      'chore/readme',
      'dev',
      'feature/login',
      'feature/login-oauth',
      'hotfix/header',
    ]);
  });

  it('keeps branches outside the default chain at the end', () => {
    const s = seedSnapshot({
      branches: [...seedBranches, { ...seedBranches[2]!, name: 'orphan', compareWith: 'gone' }],
    });
    expect(branchOrder(s).at(-1)?.name).toBe('orphan');
  });

  it('stacked branches are one level deeper than their parent', () => {
    const s = seedSnapshot();
    expect(depthOf(s, 'main')).toBe(0);
    expect(depthOf(s, 'dev')).toBe(1);
    expect(depthOf(s, 'feature/login')).toBe(2);
  });
});

describe('layoutTree', () => {
  it("draws each branch's own commits: ahead of its compare-with branch", () => {
    const s = seedSnapshot();
    const rows = layoutTree(s, new TreeGraph(s.commits)).rows;
    const shas = (name: string) =>
      rows
        .find((r) => r.branch.name === name)!
        .items.flatMap((i) => (i.kind === 'commit' ? [i.sha] : []));
    expect(shas('dev')).toEqual([SEED_SHA.d1, SEED_SHA.d2]);
    expect(shas('feature/login')).toEqual([SEED_SHA.f1, SEED_SHA.f2, SEED_SHA.f3]);
    expect(shas('feature/login-oauth')).toEqual([SEED_SHA.f1, SEED_SHA.f2, SEED_SHA.b1]);
    expect(shas('main')).toEqual([SEED_SHA.c1, SEED_SHA.c2, SEED_SHA.c3, SEED_SHA.c4]);
  });

  it('marks the head and shows older commits as a +N chip', () => {
    const commits = Array.from({ length: 10 }, (_, i) => ({
      sha: String(i).repeat(40),
      parents: i ? [String(i - 1).repeat(40)] : [],
      committedAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    }));
    const s = seedSnapshot({
      commits,
      branches: [{ ...seedBranches[0]!, headSha: commits[9]!.sha }],
    });
    const [row] = layoutTree(s, new TreeGraph(s.commits)).rows;
    expect(row!.items[0]).toMatchObject({ kind: 'more', count: 10 - MAX_SHOWN });
    const last = row!.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'commit', sha: commits[9]!.sha, isHead: true });
  });

  it('the +N chip counts commits beyond the snapshot from `ahead`', () => {
    const s = seedSnapshot({
      branches: seedBranches.map((b) => (b.name === 'dev' ? { ...b, ahead: 40 } : b)),
    });
    const row = layoutTree(s, new TreeGraph(s.commits)).rows.find((r) => r.branch.name === 'dev')!;
    expect(row.items[0]).toMatchObject({ kind: 'more', count: 38 });
  });

  it('flags merge commits (2+ parents)', () => {
    const s = seedSnapshot({
      commits: [
        ...seedSnapshot().commits,
        {
          sha: 'ab'.repeat(20),
          parents: [SEED_SHA.c4!, SEED_SHA.a1!],
          committedAt: '2026-11-02T09:00:00.000Z',
        },
      ],
      branches: seedBranches.map((b) => (b.isDefault ? { ...b, headSha: 'ab'.repeat(20) } : b)),
    });
    const main = layoutTree(s, new TreeGraph(s.commits)).rows[0]!;
    expect(main.items.at(-1)).toMatchObject({ isMerge: true, isHead: true });
  });
});

describe('labels', () => {
  it('sub line: ↑a ↓b vs X · why', () => {
    const m = byName();
    expect(subLine(m.get('main')!)).toBe('default branch');
    expect(subLine(m.get('feature/login')!)).toBe('↑3 ↓1 vs dev · PR #2');
    expect(subLine(m.get('dev')!)).toBe('↑2 ↓0 vs main · guess');
  });

  it('merged line from the PR record, new commits as a warning, content merges', () => {
    const m = byName();
    expect(mergeNote(m.get('chore/readme')!, m)).toEqual({
      text: 'merged via #1 (squash)',
      tone: 'ok',
    });
    const more = {
      ...m.get('chore/readme')!,
      merged: { ...m.get('chore/readme')!.merged!, newCommits: 2 },
    };
    expect(mergeNote(more, m)).toEqual({ text: '2 new since #1', tone: 'warn' });
    const content = {
      ...m.get('dev')!,
      merged: {
        via: 'rebased' as const,
        prNumber: null,
        method: null,
        into: 'main',
        newCommits: 0,
        mergeCommitSha: null,
      },
    };
    expect(mergeNote(content, m)?.text).toBe('content in main (rebased)');
    expect(mergeNote(m.get('dev')!, m)).toBeNull();
  });

  it('same commit as its compare-with branch', () => {
    const m = byName();
    const same = { ...m.get('hotfix/header')!, headSha: SEED_SHA.c4!, ahead: 0 };
    expect(mergeNote(same, m)).toEqual({ text: 'same commit as main', tone: 'muted' });
  });
});

import type { TreeSnapshot } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { seedSnapshot, SEED_SHA } from '@/components/tree/__fixtures__/seed-snapshot';
import { applyOverrides, clearedBranches, createsLoop } from './apply-overrides';

const node = (s: TreeSnapshot, name: string) => s.branches.find((b) => b.name === name)!;

/** The seed snapshot as the sync job would have built it with `oauth → feature/login` set by hand. */
function withStoredOverride(): TreeSnapshot {
  const s = seedSnapshot();
  return {
    ...s,
    branches: s.branches.map((b) =>
      b.name === 'feature/login-oauth'
        ? {
            ...b,
            compareWith: 'feature/login',
            why: 'override' as const,
            ahead: 1,
            behind: 1,
            mergeBase: SEED_SHA.f2!,
          }
        : b,
    ),
  };
}

describe('applyOverrides', () => {
  it('returns the same snapshot when nothing changed', () => {
    const s = seedSnapshot();
    expect(applyOverrides(s, {})).toBe(s);
  });

  it('applies a new override and recomputes that branch on the stored graph', () => {
    const s = seedSnapshot();
    const out = applyOverrides(s, { 'feature/login-oauth': 'feature/login' });
    expect(node(out, 'feature/login-oauth')).toMatchObject({
      compareWith: 'feature/login',
      why: 'override',
      whyPr: null,
      ahead: 1, // b1
      behind: 1, // f3
      mergeBase: SEED_SHA.f2,
    });
    // Other branches keep the sync job's exact values (same objects).
    expect(node(out, 'feature/login')).toBe(node(s, 'feature/login'));
  });

  it('keeps counts when only the reason changes (override = what the rules already picked)', () => {
    const s = seedSnapshot();
    const out = applyOverrides(s, { dev: 'main' });
    expect(node(out, 'dev')).toMatchObject({ compareWith: 'main', why: 'override', ahead: 2 });
  });

  it('ignores overrides on the default branch, to unknown branches, and to itself', () => {
    const s = seedSnapshot();
    expect(applyOverrides(s, { main: 'dev', dev: 'gone', 'hotfix/header': 'hotfix/header' })).toBe(
      s,
    );
  });

  it('a cleared override goes back to the automatic rules', () => {
    const s = withStoredOverride();
    expect(clearedBranches(s, {})).toEqual(['feature/login-oauth']);
    const out = applyOverrides(s, {}, { prs: [], recordedParents: {} });
    expect(node(out, 'feature/login-oauth')).toMatchObject({
      compareWith: 'dev',
      why: 'inferred',
      ahead: 3,
      behind: 1,
      mergeBase: SEED_SHA.d1,
    });
  });

  it('a cleared override uses PR records when there is one', () => {
    const s = withStoredOverride();
    const out = applyOverrides(
      s,
      {},
      {
        prs: [{ number: 9, headRef: 'feature/login-oauth', baseRef: 'main', state: 'open' }],
        recordedParents: {},
      },
    );
    expect(node(out, 'feature/login-oauth')).toMatchObject({
      compareWith: 'main',
      why: 'pr',
      whyPr: 9,
      ahead: 4,
    });
  });

  it('breaks a loop by falling back to the default branch', () => {
    const out = applyOverrides(seedSnapshot(), { dev: 'feature/login' });
    expect(node(out, 'dev')).toMatchObject({ compareWith: 'main', why: 'default', loop: true });
  });

  it('counts a head the snapshot did not draw as a lone commit (fixed by the next sync)', () => {
    const s = seedSnapshot();
    const stray = { ...s, commits: s.commits.filter((c) => c.sha !== SEED_SHA.a1) };
    const out = applyOverrides(stray, { 'hotfix/header': 'dev' });
    expect(node(out, 'hotfix/header')).toMatchObject({ compareWith: 'dev', why: 'override' });
  });
});

describe('createsLoop', () => {
  it('is true when the target already compares with the branch', () => {
    expect(createsLoop(seedSnapshot(), { dev: 'feature/login' }, 'dev')).toBe(true);
    expect(createsLoop(seedSnapshot(), { dev: 'feature/login-oauth' }, 'dev')).toBe(true);
  });

  it('is false for a normal pick', () => {
    expect(
      createsLoop(
        seedSnapshot(),
        { 'feature/login-oauth': 'feature/login' },
        'feature/login-oauth',
      ),
    ).toBe(false);
  });
});

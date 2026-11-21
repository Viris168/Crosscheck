import type { BranchNode } from '@app/shared/client';
import { describe, expect, it } from 'vitest';
import { seedBranches, seedSnapshot, SEED_SHA } from './__fixtures__/seed-snapshot';
import {
  EMPTY_VIEW,
  parseView,
  viewRows,
  viewSearch,
  type MatchContext,
  type TreeView,
  type ViewState,
} from './view';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  minePrs: new Set(),
  headTime: () => NOW,
  now: NOW,
  ...over,
});
const state = (over: Partial<ViewState> = {}): ViewState => ({
  view: EMPTY_VIEW,
  ctx: ctx(),
  collapsed: new Set(),
  mergedOpen: new Set(),
  ...over,
});
const names = (rows: ReturnType<typeof viewRows>) =>
  rows.map((r) => (r.kind === 'branch' ? r.branch.name : `[${r.names.length} merged:${r.parent}]`));

describe('URL view (?q=&f=)', () => {
  it('round-trips q and f, keeping other params and dropping unknown filters', () => {
    const view: TreeView = { q: 'login', f: ['stale', 'mine'] };
    const search = viewSearch(view, '?tab=x&q=old');
    expect(search).toBe('?tab=x&q=login&f=mine%2Cstale');
    expect(parseView(search)).toEqual({ q: 'login', f: ['mine', 'stale'] });
    expect(parseView('?f=merged,bogus,merged')).toEqual({ q: '', f: ['merged'] });
  });

  it('an empty view removes q and f', () => {
    expect(viewSearch(EMPTY_VIEW, '?q=a&f=merged')).toBe('');
    expect(viewSearch(EMPTY_VIEW, '?q=a&tab=1')).toBe('?tab=1');
  });
});

describe('viewRows', () => {
  it('keeps prototype order and folds merged branches into one row per parent', () => {
    expect(names(viewRows(seedSnapshot(), state()))).toEqual([
      'main',
      'dev',
      'feature/login',
      'feature/login-oauth',
      'hotfix/header',
      '[1 merged:main]',
    ]);
    const open = viewRows(seedSnapshot(), state({ mergedOpen: new Set(['main']) }));
    expect(names(open).slice(-2)).toEqual(['[1 merged:main]', 'chore/readme']);
  });

  it('never folds a merged branch that still has unmerged work stacked on it', () => {
    const s = seedSnapshot({
      branches: seedBranches.map((b) =>
        b.name === 'dev'
          ? {
              ...b,
              merged: {
                via: 'pr' as const,
                prNumber: 9,
                method: 'merge' as const,
                into: 'main',
                newCommits: 0,
                mergeCommitSha: null,
              },
            }
          : b,
      ),
    });
    expect(names(viewRows(s, state()))).toContain('dev');
  });

  it('collapsing a branch hides its whole compare-with subtree', () => {
    const rows = viewRows(seedSnapshot(), state({ collapsed: new Set(['dev']) }));
    expect(names(rows)).toEqual(['main', 'dev', 'hotfix/header', '[1 merged:main]']);
    const dev = rows.find((r) => r.kind === 'branch' && r.branch.name === 'dev');
    expect(dev).toMatchObject({ collapsed: true, children: 2 });
  });

  it('search shows matches plus their ancestors as context, nothing folded', () => {
    const rows = viewRows(seedSnapshot(), state({ view: { q: 'OAUTH', f: [] } }));
    expect(names(rows)).toEqual(['main', 'dev', 'feature/login-oauth']);
    expect(rows.map((r) => r.kind === 'branch' && r.context)).toEqual([true, true, false]);
  });

  it('filters: open PR, CI failing, merged, mine, stale (AND)', () => {
    const s = seedSnapshot();
    const f = (view: TreeView, c?: Partial<MatchContext>) =>
      viewRows(s, state({ view, ctx: ctx(c) }))
        .filter((r) => r.kind === 'branch' && !r.context)
        .map((r) => (r.kind === 'branch' ? r.branch.name : ''));
    expect(f({ q: '', f: ['open-pr'] })).toEqual(['feature/login', 'hotfix/header']);
    expect(f({ q: '', f: ['ci-failing'] })).toEqual(['hotfix/header']);
    expect(f({ q: '', f: ['merged'] })).toEqual(['chore/readme']);
    expect(f({ q: '', f: ['mine'] }, { minePrs: new Set([2]) })).toEqual(['feature/login']);
    const old = (sha: string) => (sha === SEED_SHA.a1 ? NOW - 31 * 86_400_000 : NOW);
    expect(f({ q: '', f: ['stale'] }, { headTime: old })).toEqual(['hotfix/header']);
    expect(f({ q: '', f: ['stale', 'open-pr'] }, { headTime: old })).toEqual(['hotfix/header']);
    expect(f({ q: 'login', f: ['ci-failing'] })).toEqual([]);
    // Unknown head time is not stale.
    expect(f({ q: '', f: ['stale'] }, { headTime: () => null })).toEqual([]);
  });

  it('handles 500 branches with deep stacks without recursion', () => {
    const base = seedBranches[0]!;
    const chain: BranchNode[] = Array.from({ length: 500 }, (_, i) => ({
      ...seedBranches[2]!,
      name: `s/${String(i).padStart(3, '0')}`,
      compareWith: i ? `s/${String(i - 1).padStart(3, '0')}` : base.name,
    }));
    const s = seedSnapshot({ branches: [base, ...chain] });
    const rows = viewRows(s, state());
    expect(rows).toHaveLength(501);
    expect(rows.at(-1)).toMatchObject({ depth: 500 });
  });
});

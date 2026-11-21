import { describe, expect, it } from 'vitest';
import {
  branchOrder,
  buildSnapshot,
  pickCompareWith,
  whyLong,
  whyShort,
  type CompareChoice,
  type PrRecord,
} from '../src';
import { commits, dag } from './helpers';

const pick = (
  c: Partial<CompareChoice> & Pick<CompareChoice, 'compareWith' | 'why'>,
): CompareChoice => ({
  whyPr: null,
  ambiguous: null,
  loop: false,
  ...c,
});
const branches = (heads: Record<string, string>, recorded: Record<string, string[]> = {}) =>
  Object.entries(heads).map(([name, headSha]) => ({
    name,
    headSha,
    recordedParents: recorded[name],
  }));

// Prototype seedWeb, commit for commit (names stand in for SHAs).
const webGraph = dag(
  'c1',
  'c2:c1',
  'r1:c2',
  'c3:c2',
  'c4:c3',
  'd1:c4',
  'd2:d1',
  'f1:d1',
  'f2:f1',
  'f3:f2',
  'o1:f2',
  'h1:c4',
);
const webHeads = {
  main: 'c4',
  'chore/readme': 'r1',
  dev: 'd2',
  'feature/login': 'f3',
  'feature/login-oauth': 'o1',
  'hotfix/header': 'h1',
};
const webPrs: PrRecord[] = [
  {
    number: 1,
    headRef: 'chore/readme',
    baseRef: 'main',
    state: 'merged',
    headSha: 'r1',
    mergeMethod: 'squash',
  },
  { number: 2, headRef: 'feature/login', baseRef: 'dev', state: 'open' },
  { number: 3, headRef: 'hotfix/header', baseRef: 'main', state: 'open' },
];

// Prototype seedApi.
const apiGraph = dag(
  'm1',
  'm2:m1',
  's1:m2',
  's2:s1',
  'm3:m2',
  's1c:m3',
  's2c:s1c',
  'a1:m2',
  'a2:a1',
  'x1:a2',
);
const apiHeads = { main: 's2c', 'docs/setup': 's2', dev: 'a2', 'feature/rate-limit': 'x1' };
const apiPrs: PrRecord[] = [
  { number: 1, headRef: 'dev', baseRef: 'main', state: 'open' },
  { number: 2, headRef: 'feature/rate-limit', baseRef: 'dev', state: 'open' },
  {
    number: 3,
    headRef: 'docs/setup',
    baseRef: 'main',
    state: 'merged',
    headSha: 's2',
    mergeMethod: 'rebase',
  },
];

describe('pickCompareWith — prototype demos', () => {
  it('web-app', () => {
    const m = pickCompareWith({
      graph: webGraph,
      defaultBranch: 'main',
      branches: branches(webHeads),
      prs: webPrs,
    });
    expect(Object.fromEntries(m)).toEqual({
      main: pick({ compareWith: null, why: 'default' }),
      'chore/readme': pick({ compareWith: 'main', why: 'pr', whyPr: 1 }),
      dev: pick({ compareWith: 'main', why: 'inferred' }),
      'feature/login': pick({ compareWith: 'dev', why: 'pr', whyPr: 2 }),
      'feature/login-oauth': pick({ compareWith: 'dev', why: 'inferred' }),
      'hotfix/header': pick({ compareWith: 'main', why: 'pr', whyPr: 3 }),
    });
  });

  it('api-server', () => {
    const m = pickCompareWith({
      graph: apiGraph,
      defaultBranch: 'main',
      branches: branches(apiHeads),
      prs: apiPrs,
    });
    expect(Object.fromEntries([...m].map(([k, v]) => [k, v.compareWith]))).toEqual({
      main: null,
      'docs/setup': 'main',
      dev: 'main',
      'feature/rate-limit': 'dev',
    });
  });
});

describe('pickCompareWith — rules', () => {
  const g = dag('m1', 'm2:m1', 'a1:m2', 'b1:a1', 'c1:m1');
  const heads = { main: 'm2', a: 'a1', b: 'b1', c: 'c1', dev: 'm1' };
  const run = (
    extra: Partial<Parameters<typeof pickCompareWith>[0]> = {},
    recorded: Record<string, string[]> = {},
  ) =>
    pickCompareWith({
      graph: g,
      defaultBranch: 'main',
      branches: branches(heads, recorded),
      ...extra,
    });

  it('1. override wins, if its target exists and is not the branch itself', () => {
    expect(run({ overrides: { b: 'c' } }).get('b')).toEqual(
      pick({ compareWith: 'c', why: 'override' }),
    );
    expect(run({ overrides: { b: 'gone' } }).get('b')!.why).toBe('inferred');
    expect(run({ overrides: new Map([['b', 'b']]) }).get('b')!.why).toBe('inferred');
  });

  it('2. newest open PR beats a newer merged one; merged used when no open; missing base ignored', () => {
    const prs: PrRecord[] = [
      { number: 4, headRef: 'b', baseRef: 'c', state: 'open' },
      { number: 7, headRef: 'b', baseRef: 'dev', state: 'merged' },
      { number: 9, headRef: 'b', baseRef: 'gone', state: 'open' },
      { number: 8, headRef: 'b', baseRef: 'main', state: 'closed' },
    ];
    expect(run({ prs }).get('b')).toEqual(pick({ compareWith: 'c', why: 'pr', whyPr: 4 }));
    expect(run({ prs: prs.filter((p) => p.number !== 4) }).get('b')).toEqual(
      pick({ compareWith: 'dev', why: 'pr', whyPr: 7 }),
    );
    expect(run({ prs: prs.filter((p) => p.number > 7) }).get('b')!.why).toBe('inferred');
  });

  it('3. recorded: one live parent → it; several → closest with ambiguous count', () => {
    expect(run({}, { b: ['c', 'deleted'] }).get('b')).toEqual(
      pick({ compareWith: 'c', why: 'recorded' }),
    );
    expect(run({}, { b: ['c', 'a'] }).get('b')).toEqual(
      pick({ compareWith: 'a', why: 'recorded', ambiguous: 2 }),
    );
  });

  it('4. inferred: long-lived or contained branches, closest wins', () => {
    const m = run();
    expect(m.get('a')!.compareWith).toBe('main'); // ahead 1 vs main, 2 vs dev
    expect(m.get('b')!.compareWith).toBe('a'); // contains a's head
    // ahead 1 vs both main and dev; dev is behind 0, but the default branch comes first in the score
    expect(m.get('c')!.compareWith).toBe('main');
  });

  it('closest score: ahead, then default, then long-lived, then behind, then name', () => {
    const g2 = dag('r', 's1:r', 'x1:s1');
    const h = { main: 'r', staging: 's1', zeta: 's1', x: 'x1' };
    // vs staging and zeta: ahead 1, behind 0; vs main: ahead 2 → staging (long-lived beats zeta)
    expect(
      pickCompareWith({ graph: g2, defaultBranch: 'main', branches: branches(h) }).get('x')!
        .compareWith,
    ).toBe('staging');
    // same score except the name → alphabetical
    const h2 = { main: 'r', alpha: 's1', beta: 's1', x: 'x1' };
    expect(
      pickCompareWith({ graph: g2, defaultBranch: 'main', branches: branches(h2) }).get('x')!
        .compareWith,
    ).toBe('alpha');
  });

  it('5. the default branch is always an inferred candidate, so "default" only appears for loops', () => {
    const solo = dag('r', 'x:r');
    expect(
      pickCompareWith({
        graph: solo,
        defaultBranch: 'main',
        branches: branches({ main: 'r', x: 'x' }),
      }).get('x'),
    ).toEqual(pick({ compareWith: 'main', why: 'inferred' }));
  });

  it('breaks loops in name order, keeping the second override', () => {
    const m = run({ overrides: { a: 'b', b: 'a' } });
    expect(m.get('a')).toEqual(pick({ compareWith: 'main', why: 'default', loop: true }));
    expect(m.get('b')).toEqual(pick({ compareWith: 'a', why: 'override' }));
  });

  it('breaks a three-way loop', () => {
    const m = run({ overrides: { a: 'b', b: 'c', c: 'a' } });
    expect(m.get('a')!.loop).toBe(true);
    expect(m.get('b')!.compareWith).toBe('c');
    expect(m.get('c')!.compareWith).toBe('a');
  });

  it('treats prototype-unsafe names as plain keys', () => {
    const m = pickCompareWith({
      graph: g,
      defaultBranch: 'main',
      branches: branches({ main: 'm2', constructor: 'a1', __proto__x: 'b1' }),
      overrides: { constructor: '__proto__x' },
    });
    expect(m.get('constructor')!.why).toBe('override');
  });

  it('rejects a default branch that is not listed and heads not in the graph', () => {
    expect(() =>
      pickCompareWith({ graph: g, defaultBranch: 'trunk', branches: branches({ a: 'a1' }) }),
    ).toThrow(/Default branch/);
    expect(() =>
      pickCompareWith({ graph: g, defaultBranch: 'main', branches: branches({ main: 'nope' }) }),
    ).toThrow(/not in the graph/);
    expect(pickCompareWith({ graph: g, defaultBranch: 'main', branches: [] }).size).toBe(0);
  });
});

describe('labels and order', () => {
  it('whyShort / whyLong match the prototype', () => {
    expect(whyShort(pick({ compareWith: 'dev', why: 'pr', whyPr: 2 }))).toBe('PR #2');
    expect(whyShort(pick({ compareWith: 'x', why: 'recorded', ambiguous: 3 }))).toBe('ambiguous');
    expect(whyShort(pick({ compareWith: 'x', why: 'override' }))).toBe('set by hand');
    expect(whyShort(pick({ compareWith: 'x', why: 'inferred' }))).toBe('guess');
    expect(whyLong(pick({ compareWith: 'dev', why: 'pr', whyPr: 2 }), 'open')).toBe(
      'Target of PR #2 (open).',
    );
    expect(whyLong(pick({ compareWith: 'main', why: 'default', loop: true }))).toBe(
      'The choices formed a loop, so the default branch.',
    );
  });

  it('branchOrder walks compare-with children by name', () => {
    const m = pickCompareWith({
      graph: webGraph,
      defaultBranch: 'main',
      branches: branches(webHeads),
      prs: webPrs,
    });
    expect(branchOrder('main', m)).toEqual([
      'main',
      'chore/readme',
      'dev',
      'feature/login',
      'feature/login-oauth',
      'hotfix/header',
    ]);
  });
});

describe('buildSnapshot', () => {
  it('fills ahead/behind, PR merge state, pr, ci and drawn commits', () => {
    const s = buildSnapshot({
      defaultBranch: 'main',
      branches: branches(webHeads),
      graph: commits(
        'c1',
        'c2:c1',
        'r1:c2',
        'c3:c2',
        'c4:c3',
        'd1:c4',
        'd2:d1',
        'f1:d1',
        'f2:f1',
        'f3:f2',
        'o1:f2',
        'h1:c4',
      ),
      prs: webPrs,
      ci: { h1: 'failure', f3: 'success' },
    });
    const by = Object.fromEntries(s.branches.map((b) => [b.name, b]));
    expect(s.branches.map((b) => b.name)).toEqual([
      'main',
      'chore/readme',
      'dev',
      'feature/login',
      'feature/login-oauth',
      'hotfix/header',
    ]);
    expect(by.main).toMatchObject({
      isDefault: true,
      compareWith: null,
      ahead: 0,
      behind: 0,
      mergeBase: null,
      merged: null,
    });
    expect(by['chore/readme']).toMatchObject({
      ahead: 1,
      behind: 2,
      mergeBase: 'c2',
      merged: { via: 'pr', prNumber: 1, method: 'squash', into: 'main', newCommits: 0 },
      pr: { number: 1, state: 'merged', baseRef: 'main' },
    });
    expect(by['feature/login-oauth']).toMatchObject({
      compareWith: 'dev',
      ahead: 3,
      behind: 1,
      mergeBase: 'd1',
      ci: 'none',
      pr: null,
    });
    expect(by['hotfix/header']).toMatchObject({
      ci: 'failure',
      pr: { number: 3, state: 'open', baseRef: 'main' },
    });
    expect(s.truncated).toBe(false);
    // every reachable commit is drawn here; parents come before children
    const order = s.commits.map((c) => c.sha);
    expect(order).toHaveLength(12);
    for (const c of s.commits)
      for (const p of c.parents) expect(order.indexOf(p)).toBeLessThan(order.indexOf(c.sha));
    expect(Object.keys(s.commits[0]!).sort()).toEqual(['committedAt', 'parents', 'sha']);
  });

  it('counts commits added after the merged PR head; no claim without the PR head', () => {
    const g = dag('m1', 'b1:m1', 'mc:m1,b1', 'b2:b1');
    const base = { defaultBranch: 'main', branches: branches({ main: 'mc', b: 'b2' }), graph: g };
    const pr = {
      number: 5,
      headRef: 'b',
      baseRef: 'main',
      state: 'merged' as const,
      mergeMethod: 'merge' as const,
    };
    expect(
      buildSnapshot({ ...base, prs: [{ ...pr, headSha: 'b1' }] }).branches[1]!.merged,
    ).toMatchObject({ newCommits: 1 });
    expect(
      buildSnapshot({ ...base, prs: [{ ...pr, headSha: 'unknown' }] }).branches[1]!.merged,
    ).toBeNull();
  });

  it('caps drawn commits per branch and reports truncated history', () => {
    const list = commits('a', 'b:a', 'c:b', 'd:c', 'e:d');
    const s = buildSnapshot({
      defaultBranch: 'main',
      branches: branches({ main: 'e' }),
      graph: list,
      maxCommitsPerBranch: 2,
    });
    expect(s.commits.map((c) => c.sha)).toEqual(['d', 'e']);
    expect(
      buildSnapshot({
        defaultBranch: 'main',
        branches: branches({ main: 'e' }),
        graph: list.slice(1),
      }).truncated,
    ).toBe(true);
    expect(
      buildSnapshot({ defaultBranch: 'main', branches: [], graph: [], truncated: true }),
    ).toEqual({
      defaultBranch: 'main',
      branches: [],
      commits: [],
      truncated: true,
    });
  });
});

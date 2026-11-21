// Fixture repos built with plain git, each with the compare-with picks the engine must make.
// `web-app` and `api-server` are the prototype's `seedWeb` / `seedApi` demos, commit for commit.
import type { CompareChoice, PrRecord } from '../core/compare-with';
import type { BranchNode } from '../types';
import { FixtureRepo } from './fixture-repo';

export interface BuiltFixture {
  name: string;
  repo: FixtureRepo;
  defaultBranch: string;
  prs: PrRecord[];
  overrides: Record<string, string>;
  recordedParents: Record<string, string[]>;
  /** expected `pickCompareWith` result per branch (fields not listed default to null/false) */
  expected: Record<string, Pick<CompareChoice, 'compareWith' | 'why'> & Partial<CompareChoice>>;
  /** expected `BranchNode.merged` (PR rule) for branches that have one; every other branch → null */
  expectedMerged: Record<string, NonNullable<BranchNode['merged']>>;
}

type Def = Omit<
  BuiltFixture,
  'name' | 'repo' | 'defaultBranch' | 'overrides' | 'recordedParents' | 'expectedMerged'
> &
  Partial<Pick<BuiltFixture, 'overrides' | 'recordedParents' | 'expectedMerged'>>;

function fixture(name: string, build: (r: FixtureRepo) => Def): () => BuiltFixture {
  return () => {
    const repo = FixtureRepo.create(name);
    try {
      const d = build(repo);
      repo.checkout('main');
      return {
        name,
        repo,
        defaultBranch: 'main',
        overrides: {},
        recordedParents: {},
        expectedMerged: {},
        ...d,
      };
    } catch (e) {
      repo.remove();
      throw e;
    }
  };
}

/** Prototype `seedWeb`. */
export const webApp = fixture('web-app', (r) => {
  r.commit('Initial commit', { 'README.md': 'web-app\n' });
  const c2 = r.commit('Add landing page');
  r.branch('chore/readme', c2);
  const r1 = r.commit('Update README', { 'README.md': 'web-app\n\nHow to run it.\n' });
  r.checkout('main');
  r.commit('Set up CI workflow');
  // PR #1 squash-merged: same change as r1, new commit on main.
  const c4 = r.commit('Update README (#1)', { 'README.md': 'web-app\n\nHow to run it.\n' });
  r.branch('dev', c4);
  const d1 = r.commit('Add API client');
  r.commit('Configure env vars');
  r.branch('feature/login', d1);
  r.commit('Login form UI');
  const f2 = r.commit('Validate credentials');
  r.commit('Remember-me option');
  r.branch('feature/login-oauth', f2);
  r.commit('Sign in with GitHub button');
  r.branch('hotfix/header', c4);
  r.commit('Fix header overflow');
  return {
    prs: [
      {
        number: 1,
        headRef: 'chore/readme',
        baseRef: 'main',
        state: 'merged',
        headSha: r1,
        mergeMethod: 'squash',
      },
      {
        number: 2,
        headRef: 'feature/login',
        baseRef: 'dev',
        state: 'open',
        headSha: r.head('feature/login'),
      },
      {
        number: 3,
        headRef: 'hotfix/header',
        baseRef: 'main',
        state: 'open',
        headSha: r.head('hotfix/header'),
      },
    ],
    expected: {
      main: { compareWith: null, why: 'default' },
      'chore/readme': { compareWith: 'main', why: 'pr', whyPr: 1 },
      dev: { compareWith: 'main', why: 'inferred' },
      'feature/login': { compareWith: 'dev', why: 'pr', whyPr: 2 },
      // Really cut from feature/login (the prototype's "really from" demo), but the graph says dev.
      'feature/login-oauth': { compareWith: 'dev', why: 'inferred' },
      'hotfix/header': { compareWith: 'main', why: 'pr', whyPr: 3 },
    },
    expectedMerged: {
      'chore/readme': { via: 'pr', prNumber: 1, method: 'squash', into: 'main', newCommits: 0 },
    },
  };
});

/** Prototype `seedApi`. */
export const apiServer = fixture('api-server', (r) => {
  r.commit('Initial commit');
  const m2 = r.commit('Add health endpoint');
  r.branch('docs/setup', m2);
  const s1 = r.commit('Write setup guide', { 'SETUP.md': '# Setup\n' });
  const s2 = r.commit('Add env var table', { 'ENV.md': '| var | use |\n' });
  r.checkout('main');
  r.commit('Add Dockerfile');
  // PR #3 rebase-merged.
  r.cherryPick([s1, s2]);
  r.branch('dev', m2);
  r.commit('Add users route');
  const a2 = r.commit('Add pagination');
  r.branch('feature/rate-limit', a2);
  r.commit('Rate limit middleware');
  return {
    prs: [
      { number: 1, headRef: 'dev', baseRef: 'main', state: 'open', headSha: a2 },
      { number: 2, headRef: 'feature/rate-limit', baseRef: 'dev', state: 'open' },
      {
        number: 3,
        headRef: 'docs/setup',
        baseRef: 'main',
        state: 'merged',
        headSha: s2,
        mergeMethod: 'rebase',
      },
    ],
    expected: {
      main: { compareWith: null, why: 'default' },
      'docs/setup': { compareWith: 'main', why: 'pr', whyPr: 3 },
      dev: { compareWith: 'main', why: 'pr', whyPr: 1 },
      'feature/rate-limit': { compareWith: 'dev', why: 'pr', whyPr: 2 },
    },
    expectedMerged: {
      'docs/setup': { via: 'pr', prNumber: 3, method: 'rebase', into: 'main', newCommits: 0 },
    },
  };
});

/** Merge-commit PRs; feature/b got one more commit after its PR merged. */
export const mergeCommit = fixture('merge-commit', (r) => {
  r.commit('Initial commit');
  r.branch('feature/a');
  r.commit('A one');
  const a2 = r.commit('A two');
  r.checkout('main');
  r.commit('Main moves');
  r.merge('feature/a', 'Merge pull request #1');
  r.branch('feature/b');
  const b1 = r.commit('B one');
  r.checkout('main');
  r.merge('feature/b', 'Merge pull request #2');
  r.checkout('feature/b');
  r.commit('B after merge');
  // A branch merged with a merge commit and no PR record (content rule only, T3a).
  r.checkout('main');
  r.branch('feature/c');
  r.commit('C one');
  r.checkout('main');
  r.merge('feature/c', 'Merge feature/c');
  return {
    prs: [
      {
        number: 1,
        headRef: 'feature/a',
        baseRef: 'main',
        state: 'merged',
        headSha: a2,
        mergeMethod: 'merge',
      },
      {
        number: 2,
        headRef: 'feature/b',
        baseRef: 'main',
        state: 'merged',
        headSha: b1,
        mergeMethod: 'merge',
      },
    ],
    expected: {
      main: { compareWith: null, why: 'default' },
      'feature/a': { compareWith: 'main', why: 'pr', whyPr: 1 },
      'feature/b': { compareWith: 'main', why: 'pr', whyPr: 2 },
      'feature/c': { compareWith: 'main', why: 'inferred' },
    },
    expectedMerged: {
      'feature/a': { via: 'pr', prNumber: 1, method: 'merge', into: 'main', newCommits: 0 },
      'feature/b': { via: 'pr', prNumber: 2, method: 'merge', into: 'main', newCommits: 1 },
    },
  };
});

/** Squash merges, with and without a PR record. */
export const squashMerge = fixture('squash-merge', (r) => {
  r.commit('Initial commit');
  r.branch('feature/sq');
  r.commit('Sq one');
  const s2 = r.commit('Sq two');
  r.checkout('main');
  r.commit('Main moves');
  r.squash('feature/sq', 'Sq (#1)');
  r.branch('feature/sq-nopr');
  r.commit('Nopr one');
  r.commit('Nopr two');
  r.checkout('main');
  r.squash('feature/sq-nopr', 'Nopr squashed');
  return {
    prs: [
      {
        number: 1,
        headRef: 'feature/sq',
        baseRef: 'main',
        state: 'merged',
        headSha: s2,
        mergeMethod: 'squash',
      },
    ],
    expected: {
      main: { compareWith: null, why: 'default' },
      'feature/sq': { compareWith: 'main', why: 'pr', whyPr: 1 },
      'feature/sq-nopr': { compareWith: 'main', why: 'inferred' },
    },
    expectedMerged: {
      'feature/sq': { via: 'pr', prNumber: 1, method: 'squash', into: 'main', newCommits: 0 },
    },
  };
});

/** Rebase merges (cherry-picks onto main), a branch with no PR record, and a partially picked branch. */
export const rebaseMerge = fixture('rebase-merge', (r) => {
  r.commit('Initial commit');
  r.branch('feature/rb');
  const r1 = r.commit('Rb one');
  const r2 = r.commit('Rb two');
  r.checkout('main');
  r.branch('feature/rb-nopr');
  const n1 = r.commit('Nopr one');
  r.checkout('main');
  r.branch('feature/partial');
  const p1 = r.commit('Partial one');
  r.commit('Partial two');
  r.checkout('main');
  r.commit('Main moves');
  r.cherryPick([r1, r2, n1, p1]);
  return {
    prs: [
      {
        number: 1,
        headRef: 'feature/rb',
        baseRef: 'main',
        state: 'merged',
        headSha: r2,
        mergeMethod: 'rebase',
      },
    ],
    expected: {
      main: { compareWith: null, why: 'default' },
      'feature/rb': { compareWith: 'main', why: 'pr', whyPr: 1 },
      'feature/rb-nopr': { compareWith: 'main', why: 'inferred' },
      'feature/partial': { compareWith: 'main', why: 'inferred' },
    },
    expectedMerged: {
      'feature/rb': { via: 'pr', prNumber: 1, method: 'rebase', into: 'main', newCommits: 0 },
    },
  };
});

/** main → a → b → c, none of them with a PR. */
export const stacked = fixture('stacked', (r) => {
  r.commit('Initial commit');
  r.branch('a');
  r.commit('A');
  r.branch('b');
  r.commit('B');
  r.branch('c');
  r.commit('C');
  r.checkout('main');
  r.commit('Main moves');
  return {
    prs: [],
    expected: {
      main: { compareWith: null, why: 'default' },
      a: { compareWith: 'main', why: 'inferred' },
      b: { compareWith: 'a', why: 'inferred' },
      c: { compareWith: 'b', why: 'inferred' },
    },
  };
});

/** x and y on one commit; z appeared there too (recorded, ambiguous); w recorded from x (+ a deleted branch). */
export const twoOnOne = fixture('two-on-one', (r) => {
  r.commit('Initial commit');
  r.commit('Main two');
  r.branch('x');
  const t1 = r.commit('Shared');
  r.branch('y', t1);
  r.branch('z', t1);
  r.branch('w', t1);
  r.commit('W one');
  return {
    prs: [],
    recordedParents: { z: ['x', 'y'], w: ['x', 'gone'] },
    expected: {
      main: { compareWith: null, why: 'default' },
      x: { compareWith: 'main', why: 'inferred' },
      y: { compareWith: 'main', why: 'inferred' },
      z: { compareWith: 'x', why: 'recorded', ambiguous: 2 },
      w: { compareWith: 'x', why: 'recorded' },
    },
  };
});

/** Criss-cross merge: p and q each merged the other's first commit, so they have two merge bases. */
export const crissCross = fixture('criss-cross', (r) => {
  r.commit('Initial commit');
  r.branch('p');
  const p1 = r.commit('P one');
  r.checkout('main');
  r.branch('q');
  const q1 = r.commit('Q one');
  r.checkout('p');
  r.merge(q1, 'P merges Q');
  r.commit('P two');
  r.checkout('q');
  r.merge(p1, 'Q merges P');
  r.commit('Q two');
  return {
    prs: [],
    expected: {
      main: { compareWith: null, why: 'default' },
      p: { compareWith: 'main', why: 'inferred' },
      q: { compareWith: 'main', why: 'inferred' },
    },
  };
});

/** Behind and ahead at once, plus a release branch (long-lived) to exercise the score order. */
export const behindAhead = fixture('behind-ahead', (r) => {
  const m1 = r.commit('Initial commit');
  const m2 = r.commit('Main two');
  r.commit('Main three');
  r.branch('feature/old', m1);
  r.commit('Old one');
  r.commit('Old two');
  r.branch('release/1.0', m2);
  r.branch('feature/new', m2);
  r.commit('New one');
  return {
    prs: [],
    expected: {
      main: { compareWith: null, why: 'default' },
      // ahead 2 vs both; the default branch wins the tie before behind is looked at.
      'feature/old': { compareWith: 'main', why: 'inferred' },
      'release/1.0': { compareWith: 'main', why: 'inferred' },
      // ahead 1 vs both main and release/1.0 → default first (prototype score order).
      'feature/new': { compareWith: 'main', why: 'inferred' },
    },
  };
});

/** Two overrides pointing at each other: the first by name falls back to the default. */
export const overrideLoop = fixture('override-loop', (r) => {
  r.commit('Initial commit');
  r.branch('p');
  r.commit('P one');
  r.checkout('main');
  r.branch('q');
  r.commit('Q one');
  return {
    prs: [],
    overrides: { p: 'q', q: 'p' },
    expected: {
      main: { compareWith: null, why: 'default' },
      p: { compareWith: 'main', why: 'default', loop: true },
      q: { compareWith: 'p', why: 'override' },
    },
  };
});

export const allFixtures = {
  webApp,
  apiServer,
  mergeCommit,
  squashMerge,
  rebaseMerge,
  stacked,
  twoOnOne,
  crissCross,
  behindAhead,
  overrideLoop,
};

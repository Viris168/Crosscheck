// Copy of the seed `RepoGraph` snapshot (packages/db/prisma/seed.ts → "branch tree"), which mirrors
// the prototype's web-app demo. Kept here so component tests don't import the seed script.
import { TreeSnapshotSchema, type BranchNode, type TreeSnapshot } from '@app/shared/client';

export const fakeSha = (tag: string) => tag.repeat(20);
const C = Object.fromEntries(
  ['c1', 'c2', 'e1', 'c3', 'c4', 'd1', 'd2', 'f1', 'f2', 'f3', 'b1', 'a1'].map((t) => [
    t,
    fakeSha(t),
  ]),
) as Record<string, string>;
const commitOrder: [string, string[]][] = [
  ['c1', []],
  ['c2', ['c1']],
  ['e1', ['c2']],
  ['c3', ['c2']],
  ['c4', ['c3']],
  ['d1', ['c4']],
  ['d2', ['d1']],
  ['f1', ['d1']],
  ['f2', ['f1']],
  ['f3', ['f2']],
  ['b1', ['f2']],
  ['a1', ['c4']],
];
const T0 = Date.parse('2026-11-01T09:00:00Z');
const base = {
  isDefault: false,
  whyPr: null,
  ambiguous: null,
  loop: false,
  merged: null,
  pr: null,
  ci: 'none',
  recorded: false,
} satisfies Partial<BranchNode>;

export const seedBranches: BranchNode[] = [
  {
    ...base,
    name: 'main',
    headSha: C.c4!,
    isDefault: true,
    compareWith: null,
    why: 'default',
    ahead: 0,
    behind: 0,
    mergeBase: null,
    ci: 'success',
  },
  {
    ...base,
    name: 'chore/readme',
    headSha: C.e1!,
    compareWith: 'main',
    why: 'pr',
    whyPr: 1,
    ahead: 1,
    behind: 2,
    mergeBase: C.c2!,
    merged: {
      via: 'pr',
      prNumber: 1,
      method: 'squash',
      into: 'main',
      newCommits: 0,
      mergeCommitSha: C.c4!,
    },
    pr: { number: 1, state: 'merged', baseRef: 'main' },
    ci: 'success',
  },
  {
    ...base,
    name: 'dev',
    headSha: C.d2!,
    compareWith: 'main',
    why: 'inferred',
    ahead: 2,
    behind: 0,
    mergeBase: C.c4!,
  },
  {
    ...base,
    name: 'feature/login',
    headSha: C.f3!,
    compareWith: 'dev',
    why: 'pr',
    whyPr: 2,
    ahead: 3,
    behind: 1,
    mergeBase: C.d1!,
    pr: { number: 2, state: 'open', baseRef: 'dev' },
    ci: 'success',
  },
  {
    ...base,
    name: 'feature/login-oauth',
    headSha: C.b1!,
    compareWith: 'dev',
    why: 'inferred',
    ahead: 3,
    behind: 1,
    mergeBase: C.d1!,
  },
  {
    ...base,
    name: 'hotfix/header',
    headSha: C.a1!,
    compareWith: 'main',
    why: 'pr',
    whyPr: 3,
    ahead: 1,
    behind: 0,
    mergeBase: C.c4!,
    pr: { number: 3, state: 'open', baseRef: 'main' },
    ci: 'failure',
  },
];

export function seedSnapshot(over: Partial<TreeSnapshot> = {}): TreeSnapshot {
  return TreeSnapshotSchema.parse({
    defaultBranch: 'main',
    branches: seedBranches,
    commits: commitOrder.map(([id, parents], i) => ({
      sha: C[id],
      parents: parents.map((p) => C[p]),
      committedAt: new Date(T0 + i * 3_600_000).toISOString(),
    })),
    truncated: false,
    ...over,
  });
}

export const SEED_SHA = C;

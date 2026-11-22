/* Dev seed: one org (+ owner), installation, repo, PR, one review in each status, and a branch tree.
 * Idempotent: deletes the seed rows (by fixed ids) and recreates them.
 * Run: pnpm db:seed */
import { defaultRepoSettings, ReviewStatus, TreeSnapshotSchema } from '@app/shared';
import type { BranchNode, CiState, TreeSnapshot } from '@app/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/index';

const IDS = {
  user: 'seed_user_owner',
  org: 'seed_org_acme',
  member: 'seed_member_owner',
  installation: 'seed_installation',
  repo: 'seed_repo_web',
  pull: 'seed_pr_42',
} as const;

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OLD_HEAD = '0f9e8d7c6b5a49382716051f2e3d4c5b6a798081';

const reviews: Record<ReviewStatus, Omit<Prisma.ReviewUncheckedCreateInput, 'pullRequestId'>> = {
  queued: { id: 'seed_review_queued', headSha: HEAD, provider: 'platform', status: 'queued' },
  running: {
    id: 'seed_review_running',
    headSha: HEAD,
    provider: 'codex_chatgpt',
    status: 'running',
    filesTotal: 12,
    filesDone: 5,
    startedAt: new Date(),
  },
  waiting_action: {
    id: 'seed_review_waiting',
    headSha: HEAD,
    provider: 'claude_action',
    status: 'waiting_action',
  },
  completed: {
    id: 'seed_review_completed',
    // older head → shows as stale in the dashboard
    headSha: OLD_HEAD,
    provider: 'platform',
    status: 'completed',
    filesTotal: 12,
    filesDone: 12,
    aiRiskScore: 60,
    riskScore: 64,
    riskLevel: 'high',
    riskFactors: [
      { key: 'ai', label: 'AI risk estimate', points: 24 },
      { key: 'severity', label: 'High-severity findings', points: 25 },
      { key: 'sensitive_paths', label: 'Touches auth code', points: 15 },
    ],
    summary: 'Adds session refresh. One injection risk and a missing null check.',
    startedAt: new Date(Date.now() - 5 * 60_000),
    finishedAt: new Date(Date.now() - 3 * 60_000),
  },
  failed: {
    id: 'seed_review_failed',
    headSha: HEAD,
    provider: 'codex_action',
    status: 'failed',
    errorCode: 'action_missing',
    errorMessage: 'No result received from the GitHub Action within 30 minutes.',
    finishedAt: new Date(),
  },
  cancelled: {
    id: 'seed_review_cancelled',
    headSha: OLD_HEAD,
    provider: 'codex_chatgpt',
    status: 'cancelled',
    finishedAt: new Date(Date.now() - 10 * 60_000),
  },
};

// ---------------------------------------------------------------- branch tree
// Mirrors the prototype's web-app demo (`seedWeb()` in docs/branch-tree/prototype.html). Made-up SHAs,
// no commit messages (the snapshot never carries them). Lets lane F build the page before the sync job.
//
//   c1 ─ c2 ─ c3 ─ c4 (main) ─ d1 ─ d2 (dev)
//          └ e1 (chore/readme, squashed into c4 by PR #1)
//                      │       └ f1 ─ f2 ─ f3 (feature/login, PR #2 → dev)
//                      │                └ b1 (feature/login-oauth)
//                      └ a1 (hotfix/header, PR #3 → main, CI failing)
const fakeSha = (tag: string) => tag.repeat(20);
const C = {
  c1: fakeSha('c1'),
  c2: fakeSha('c2'),
  e1: fakeSha('e1'),
  c3: fakeSha('c3'),
  c4: fakeSha('c4'),
  d1: fakeSha('d1'),
  d2: fakeSha('d2'),
  f1: fakeSha('f1'),
  f2: fakeSha('f2'),
  f3: fakeSha('f3'),
  b1: fakeSha('b1'),
  a1: fakeSha('a1'),
} as const;
const commitOrder: [keyof typeof C, (keyof typeof C)[]][] = [
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
  headCommittedAt: null,
} satisfies Partial<BranchNode>;

const treeBranches: BranchNode[] = [
  {
    ...base,
    name: 'main',
    headSha: C.c4,
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
    headSha: C.e1,
    compareWith: 'main',
    why: 'pr',
    whyPr: 1,
    ahead: 1,
    behind: 2,
    mergeBase: C.c2,
    merged: {
      via: 'pr',
      prNumber: 1,
      method: 'squash',
      into: 'main',
      newCommits: 0,
      mergeCommitSha: C.c4,
    },
    pr: { number: 1, state: 'merged', baseRef: 'main', author: null },
    ci: 'success',
  },
  {
    // No PR, nothing recorded: inferred. Only long-lived candidate besides itself is main.
    ...base,
    name: 'dev',
    headSha: C.d2,
    compareWith: 'main',
    why: 'inferred',
    ahead: 2,
    behind: 0,
    mergeBase: C.c4,
  },
  {
    ...base,
    name: 'feature/login',
    headSha: C.f3,
    compareWith: 'dev',
    why: 'pr',
    whyPr: 2,
    ahead: 3,
    behind: 1,
    mergeBase: C.d1,
    pr: { number: 2, state: 'open', baseRef: 'dev', author: null },
    ci: 'success',
  },
  {
    // Inferred. feature/login moved on (f3 is not in this branch), so it is not a candidate; of the
    // long-lived ones, dev (3 ahead) beats main (4 ahead). Same result as the prototype's inferBase().
    ...base,
    name: 'feature/login-oauth',
    headSha: C.b1,
    compareWith: 'dev',
    why: 'inferred',
    ahead: 3,
    behind: 1,
    mergeBase: C.d1,
  },
  {
    ...base,
    name: 'hotfix/header',
    headSha: C.a1,
    compareWith: 'main',
    why: 'pr',
    whyPr: 3,
    ahead: 1,
    behind: 0,
    mergeBase: C.c4,
    pr: { number: 3, state: 'open', baseRef: 'main', author: null },
    ci: 'failure',
  },
];

const treeSnapshot: TreeSnapshot = TreeSnapshotSchema.parse({
  defaultBranch: 'main',
  branches: treeBranches,
  commits: commitOrder.map(([id, parents], i) => ({
    sha: C[id],
    parents: parents.map((p) => C[p]),
    committedAt: new Date(T0 + i * 3_600_000).toISOString(),
  })),
  truncated: false,
});

const ciCounts: Record<CiState, Record<string, number>> = {
  success: { success: 3 },
  failure: { success: 2, failure: 1 },
  pending: { pending: 1 },
  neutral: { neutral: 1 },
  none: {},
};

async function main() {
  // Cascades remove installation, repo, PR, reviews, issues, members.
  await prisma.organization.deleteMany({ where: { id: IDS.org } });
  await prisma.user.deleteMany({ where: { id: IDS.user } });

  await prisma.user.create({
    data: {
      id: IDS.user,
      name: 'Octo Owner',
      email: 'owner@example.com',
      emailVerified: true,
      login: 'octo-owner',
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
    },
  });

  await prisma.organization.create({
    data: {
      id: IDS.org,
      name: 'Acme',
      slug: 'acme',
      githubAccountLogin: 'acme',
      githubAccountType: 'Organization',
      plan: 'free',
      members: { create: { id: IDS.member, userId: IDS.user, role: 'owner' } },
      installations: { create: { id: IDS.installation, githubInstallationId: 1000001 } },
    },
  });

  await prisma.repo.create({
    data: {
      id: IDS.repo,
      orgId: IDS.org,
      installationId: IDS.installation,
      githubRepoId: 2000001,
      fullName: 'acme/web',
      provider: 'platform',
      settings: defaultRepoSettings(),
      pullRequests: {
        create: {
          id: IDS.pull,
          number: 42,
          title: 'feat(auth): refresh sessions',
          body: 'Refresh sessions before they expire.',
          author: 'octo-owner',
          state: 'open',
          headSha: HEAD,
          baseRef: 'main',
          headRef: 'feat/session-refresh',
          additions: 180,
          deletions: 40,
          changedFiles: 12,
        },
      },
    },
  });

  for (const status of ReviewStatus) {
    await prisma.review.create({ data: { ...reviews[status], pullRequestId: IDS.pull } });
  }

  await prisma.issue.createMany({
    data: [
      {
        reviewId: reviews.completed.id!,
        file: 'src/auth/session.ts',
        line: 31,
        severity: 'high',
        category: 'security',
        title: 'SQL built from user input',
        explanation: 'The session id is interpolated into a raw query.',
        suggestedFix: 'Use a parameterized query.',
        posted: true,
      },
      {
        reviewId: reviews.completed.id!,
        file: 'src/auth/refresh.ts',
        line: 12,
        severity: 'medium',
        category: 'bug',
        title: 'Missing null check',
        explanation: '`session` can be null when the cookie is missing.',
        posted: true,
      },
    ],
  });

  await prisma.repoGraph.create({
    data: {
      repoId: IDS.repo,
      status: 'ready',
      defaultBranch: treeSnapshot.defaultBranch,
      syncedAt: new Date(),
      snapshot: treeSnapshot,
    },
  });
  await prisma.branch.createMany({
    data: treeBranches.map((b) => ({
      repoId: IDS.repo,
      name: b.name,
      headSha: b.headSha,
      isDefault: b.isDefault,
    })),
  });
  // CommitCi has no relation to Repo (no cascade), so clear it by repoId first.
  await prisma.commitCi.deleteMany({ where: { repoId: IDS.repo } });
  await prisma.commitCi.createMany({
    data: treeBranches
      .filter((b) => b.ci !== 'none')
      .map((b) => ({ repoId: IDS.repo, sha: b.headSha, state: b.ci, counts: ciCounts[b.ci] })),
  });

  console.warn(
    `Seeded org "acme" with ${ReviewStatus.length} reviews and ${treeBranches.length} branches.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

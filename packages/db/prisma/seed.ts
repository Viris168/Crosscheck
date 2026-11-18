/* Dev seed: one org (+ owner), installation, repo, PR, and one review in each status.
 * Idempotent: deletes the seed rows (by fixed ids) and recreates them.
 * Run: pnpm db:seed */
import { defaultRepoSettings, ReviewStatus } from '@app/shared';
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

  console.warn(`Seeded org "acme" with ${ReviewStatus.length} reviews.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

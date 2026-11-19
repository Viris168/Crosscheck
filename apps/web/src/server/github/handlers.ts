import 'server-only';
import { randomUUID } from 'node:crypto';
import { prisma } from '@app/db';
import { fetchPullRequest, getInstallationOctokit, splitFullName } from '@app/github';
import {
  RepoSettingsSchema,
  defaultRepoSettings,
  type ProviderId,
  type RepoSettings,
} from '@app/shared';
import { logger } from '@/server/logger';
import {
  InstallationPayload,
  InstallationRepositoriesPayload,
  IssueCommentPayload,
  MemberPayload,
  OrganizationPayload,
  PullRequestPayload,
  type PullRequestData,
} from './payloads';
import { syncUserMemberships } from './membership';
import { invalidateRepoPermission } from './permissions';
import { requestReview } from './reviews';

/** What a handler did — logged and returned in the webhook response (no sensitive data). */
export interface HandlerResult {
  handled: boolean;
  note?: string;
  reviewId?: string;
}

const ignored = (note: string): HandlerResult => ({ handled: false, note });

// ---------------------------------------------------------------- org + installation

interface GithubAccount {
  id: number;
  login: string;
  /** `installation.account.type`: 'Organization' | 'User' (anything else is not stored). */
  type?: string;
}

function accountType(account: GithubAccount): 'Organization' | 'User' | undefined {
  return account.type === 'Organization' || account.type === 'User' ? account.type : undefined;
}

function slugify(login: string): string {
  return (
    login
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'org'
  );
}

/**
 * Finds the Better Auth Organization for a GitHub account (by `githubAccountLogin`, case-insensitive)
 * or creates it. The installing user (matched via `Account.accountId` = GitHub user id) becomes
 * `owner` when the org is new or has no members yet. Stores `githubAccountType` from
 * `account.type` (also on existing orgs).
 */
export async function ensureOrganization(
  account: GithubAccount,
  sender: GithubAccount,
): Promise<string> {
  let org = await prisma.organization.findFirst({
    where: { githubAccountLogin: { equals: account.login, mode: 'insensitive' } },
    select: { id: true, githubAccountType: true },
  });
  const type = accountType(account);

  if (org && type && org.githubAccountType !== type) {
    await prisma.organization.update({ where: { id: org.id }, data: { githubAccountType: type } });
  }

  if (!org) {
    const base = slugify(account.login);
    const taken = await prisma.organization.findUnique({
      where: { slug: base },
      select: { id: true },
    });
    org = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: account.login,
        slug: taken ? `${base}-gh${account.id}` : base,
        githubAccountLogin: account.login,
        githubAccountType: type ?? null,
      },
      select: { id: true, githubAccountType: true },
    });
    logger.info({ orgId: org.id }, 'organization created from GitHub installation');
  }

  const user = await prisma.account.findFirst({
    where: { providerId: 'github', accountId: String(sender.id) },
    select: { userId: true },
  });
  if (user) {
    const members = await prisma.member.count({ where: { organizationId: org.id } });
    if (members === 0) {
      await prisma.member.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.userId } },
        create: { id: randomUUID(), organizationId: org.id, userId: user.userId, role: 'owner' },
        update: {},
      });
    }
  }
  return org.id;
}

async function upsertInstallation(
  githubInstallationId: number,
  orgId: string,
  opts: { clearNeedsMemberPermission?: boolean } = {},
) {
  const clear = opts.clearNeedsMemberPermission ? { needsMemberPermission: false } : {};
  return prisma.installation.upsert({
    where: { githubInstallationId },
    create: { githubInstallationId, orgId },
    update: { orgId, ...clear },
    select: { id: true, orgId: true },
  });
}

async function upsertRepos(
  installation: { id: string; orgId: string },
  repos: readonly { id: number; full_name: string }[],
): Promise<void> {
  for (const r of repos) {
    await prisma.repo.upsert({
      where: { githubRepoId: r.id },
      create: {
        githubRepoId: r.id,
        fullName: r.full_name,
        orgId: installation.orgId,
        installationId: installation.id,
        provider: 'platform',
        settings: defaultRepoSettings(),
        active: true,
      },
      // Keep the user's provider + settings on re-add.
      update: {
        fullName: r.full_name,
        orgId: installation.orgId,
        installationId: installation.id,
        active: true,
      },
    });
  }
}

async function deactivateInstallationRepos(githubInstallationId: number): Promise<number> {
  const { count } = await prisma.repo.updateMany({
    where: { installation: { githubInstallationId } },
    data: { active: false },
  });
  return count;
}

export async function handleInstallation(body: unknown): Promise<HandlerResult> {
  const p = InstallationPayload.parse(body);
  const ghId = p.installation.id;

  switch (p.action) {
    case 'created':
    case 'new_permissions_accepted':
    case 'unsuspend': {
      const orgId = await ensureOrganization(p.installation.account, p.sender);
      // Accepting the new permissions grants Organization → Members: read.
      const inst = await upsertInstallation(ghId, orgId, {
        clearNeedsMemberPermission: p.action === 'new_permissions_accepted',
      });
      await upsertRepos(inst, p.repositories ?? []);
      return { handled: true, note: `installation ${p.action}` };
    }
    case 'deleted':
    case 'suspend': {
      const count = await deactivateInstallationRepos(ghId);
      return { handled: true, note: `installation ${p.action}: ${count} repos deactivated` };
    }
    default:
      return ignored(`installation.${p.action}`);
  }
}

export async function handleInstallationRepositories(body: unknown): Promise<HandlerResult> {
  const p = InstallationRepositoriesPayload.parse(body);
  if (p.action !== 'added' && p.action !== 'removed') {
    return ignored(`installation_repositories.${p.action}`);
  }
  const orgId = await ensureOrganization(p.installation.account, p.sender);
  const inst = await upsertInstallation(p.installation.id, orgId);
  await upsertRepos(inst, p.repositories_added);
  if (p.repositories_removed.length > 0) {
    await prisma.repo.updateMany({
      where: { githubRepoId: { in: p.repositories_removed.map((r) => r.id) } },
      data: { active: false },
    });
  }
  return {
    handled: true,
    note: `+${p.repositories_added.length} -${p.repositories_removed.length} repos`,
  };
}

// ---------------------------------------------------------------- members (task H, Part 4)

/** Our user id for a GitHub user id, or null if they never signed in. Never matched by login. */
async function findUserIdByGithubId(githubUserId: number): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { providerId: 'github', accountId: String(githubUserId) },
    select: { userId: true },
  });
  return account?.userId ?? null;
}

/** `organization.member_removed`: the user leaves our org right away. */
export async function handleOrganization(body: unknown): Promise<HandlerResult> {
  const p = OrganizationPayload.parse(body);
  // member_added: nothing to do, they join at their next sign-in.
  if (p.action !== 'member_removed') return ignored(`organization.${p.action}`);

  const ghUser = p.membership?.user;
  if (!ghUser) return ignored('no membership user');
  const userId = await findUserIdByGithubId(ghUser.id);
  if (!userId) return ignored('unknown user');

  const org = await prisma.organization.findFirst({
    where: { githubAccountLogin: { equals: p.organization.login, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!org) return ignored('unknown organization');

  const { count } = await prisma.member.deleteMany({ where: { organizationId: org.id, userId } });
  logger.info({ userId, orgId: org.id, removed: count }, 'member removed on GitHub');
  return { handled: true, note: count > 0 ? 'member removed' : 'not a member' };
}

/** `member.removed` / `member.edited`: a repo collaborator's access changed. */
export async function handleMember(body: unknown): Promise<HandlerResult> {
  const p = MemberPayload.parse(body);
  if (p.action !== 'removed' && p.action !== 'edited') return ignored(`member.${p.action}`);

  const userId = await findUserIdByGithubId(p.member.id);
  if (!userId) return ignored('unknown user');

  await invalidateRepoPermission(p.repository.id, p.member.login);

  // Personal installs have no GitHub org: membership follows repo collaborators.
  const repo = await prisma.repo.findUnique({
    where: { githubRepoId: p.repository.id },
    select: { orgId: true, org: { select: { githubAccountType: true } } },
  });
  if (repo?.org.githubAccountType !== 'User') {
    return { handled: true, note: 'permission cache invalidated' };
  }
  const { joined, left } = await syncUserMemberships(userId);
  return {
    handled: true,
    note: `permission cache invalidated; sync +${joined.length} -${left.length}`,
  };
}

// ---------------------------------------------------------------- pull requests

interface ActiveRepo {
  id: string;
  orgId: string;
  provider: ProviderId;
  settings: RepoSettings;
  fullName: string;
}

async function findActiveRepo(githubRepoId: number): Promise<ActiveRepo | null> {
  const repo = await prisma.repo.findUnique({
    where: { githubRepoId },
    select: { id: true, orgId: true, provider: true, settings: true, fullName: true, active: true },
  });
  if (!repo || !repo.active) return null;
  const parsed = RepoSettingsSchema.safeParse(repo.settings ?? {});
  return {
    id: repo.id,
    orgId: repo.orgId,
    provider: repo.provider,
    fullName: repo.fullName,
    settings: parsed.success ? parsed.data : defaultRepoSettings(),
  };
}

function prState(pr: PullRequestData): 'open' | 'closed' | 'merged' {
  if (pr.state === 'open') return 'open';
  return pr.merged ? 'merged' : 'closed';
}

async function upsertPullRequest(repoId: string, pr: PullRequestData) {
  const data = {
    title: pr.title,
    body: pr.body ?? null,
    author: pr.user?.login ?? 'ghost',
    state: prState(pr),
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
  };
  return prisma.pullRequest.upsert({
    where: { repoId_number: { repoId, number: pr.number } },
    create: { repoId, number: pr.number, ...data },
    update: data,
    select: { id: true, headSha: true, state: true },
  });
}

const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export async function handlePullRequest(body: unknown): Promise<HandlerResult> {
  const p = PullRequestPayload.parse(body);
  const isReviewAction = REVIEW_ACTIONS.has(p.action);
  if (!isReviewAction && p.action !== 'closed') return ignored(`pull_request.${p.action}`);

  const repo = await findActiveRepo(p.repository.id);
  if (!repo) return ignored('repo not installed or inactive');

  const pr = await upsertPullRequest(repo.id, p.pull_request);
  if (p.action === 'closed') return { handled: true, note: `pull request ${pr.state}` };

  if (p.pull_request.draft) return { handled: true, note: 'draft skipped' };
  if (repo.settings.trigger !== 'every_push') return { handled: true, note: 'trigger on_command' };

  const result = await requestReview({
    pullRequestId: pr.id,
    headSha: pr.headSha,
    provider: repo.provider,
    orgId: repo.orgId,
    repoId: repo.id,
  });
  return result.created
    ? { handled: true, reviewId: result.reviewId, note: `review ${result.status}` }
    : { handled: true, note: 'review already exists' };
}

// ---------------------------------------------------------------- /review command

/** `/review` alone or followed by whitespace (not `/reviewer`). */
const REVIEW_COMMAND = /^\/review(?:\s|$)/;
/** Only people with write-ish access may trigger (paid) reviews from a comment. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export async function handleIssueComment(body: unknown): Promise<HandlerResult> {
  const p = IssueCommentPayload.parse(body);
  if (p.action !== 'created') return ignored(`issue_comment.${p.action}`);
  if (!p.issue.pull_request) return ignored('not a pull request');
  if (!REVIEW_COMMAND.test((p.comment.body ?? '').trim())) return ignored('not a /review command');
  if (p.comment.user?.type === 'Bot' || p.sender?.type === 'Bot') return ignored('bot comment');
  if (!TRUSTED_ASSOCIATIONS.has(p.comment.author_association ?? '')) {
    return ignored('commenter not allowed to trigger reviews');
  }

  const repo = await findActiveRepo(p.repository.id);
  if (!repo) return ignored('repo not installed or inactive');

  let pr = await prisma.pullRequest.findUnique({
    where: { repoId_number: { repoId: repo.id, number: p.issue.number } },
    select: { id: true, headSha: true, state: true },
  });

  if (!pr) {
    // We missed the pull_request webhook (e.g. PR opened before install): fetch it once.
    if (!p.installation) return ignored('unknown pull request');
    const { owner, repo: name } = splitFullName(repo.fullName);
    const octokit = await getInstallationOctokit(p.installation.id);
    const meta = await fetchPullRequest(octokit, owner, name, p.issue.number);
    pr = await upsertPullRequest(repo.id, {
      number: meta.number,
      title: meta.title,
      body: meta.body,
      user: { login: meta.author },
      state: meta.state,
      merged: meta.merged,
      draft: meta.draft,
      head: { sha: meta.headSha, ref: meta.headRef },
      base: { ref: meta.baseRef },
      additions: meta.additions,
      deletions: meta.deletions,
      changed_files: meta.changedFiles,
    });
  }

  if (pr.state !== 'open') return ignored('pull request is not open');

  const result = await requestReview({
    pullRequestId: pr.id,
    headSha: pr.headSha,
    provider: repo.provider,
    orgId: repo.orgId,
    repoId: repo.id,
  });
  return result.created
    ? { handled: true, reviewId: result.reviewId, note: `review ${result.status}` }
    : { handled: true, note: 'review already exists' };
}

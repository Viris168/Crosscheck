import 'server-only';
import { prisma } from '@app/db';
import { HttpError, type MemberRole } from '@app/shared';
import { requireOrgMember } from '@/server/auth';
import { getRepoPermission, permissionAtLeast, type RepoPermission } from '@/server/github';
import { logger } from '@/server/logger';

/** Org roles that see and change every repo of the org without a GitHub permission check. */
export const ADMIN_ROLES: readonly MemberRole[] = ['owner', 'admin'];

/** Lookups in flight at once when filtering a repo list by GitHub permission. */
const VISIBLE_REPOS_CONCURRENCY = 5;

const NO_LOGIN = 'Link your GitHub account';
const NO_READ = 'No access to this repository on GitHub';
const NO_WRITE = 'Requires write access to this repository on GitHub';

/** 502 `github_error`: GitHub didn't answer the permission check, so deny (fail closed). */
function githubError(): HttpError {
  return new HttpError('github_error', 'Could not check your access on GitHub. Try again.');
}

const isOrgAdmin = (role: MemberRole) => ADMIN_ROLES.includes(role);

async function loadRepo(repoId: string) {
  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    include: { installation: true },
  });
  if (!repo) throw new HttpError('not_found', 'Repository not found');
  return repo;
}
type RepoWithInstallation = Awaited<ReturnType<typeof loadRepo>>;

async function loginOf(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { login: true } });
  return user?.login ?? null;
}

function permissionOn(repo: RepoWithInstallation, login: string): Promise<RepoPermission> {
  return getRepoPermission({
    githubInstallationId: repo.installation.githubInstallationId,
    githubRepoId: repo.githubRepoId,
    fullName: repo.fullName,
    login,
  });
}

/**
 * 404 if the repo doesn't exist; 403 unless the user is an org member with at least `need` on the
 * repo (org owner/admin always pass, without a GitHub call). A GitHub error → 502 (fail closed).
 */
async function requireRepoPermission(userId: string, repoId: string, need: 'read' | 'write') {
  const repo = await loadRepo(repoId);
  const { role } = await requireOrgMember(userId, repo.orgId);
  if (isOrgAdmin(role)) return repo;

  const login = await loginOf(userId);
  if (!login) throw new HttpError('forbidden', NO_LOGIN);

  let permission: RepoPermission;
  try {
    permission = await permissionOn(repo, login);
  } catch (err) {
    logger.warn(
      { userId, repoId, err: err instanceof Error ? err.message : String(err) },
      'GitHub repo permission check failed',
    );
    throw githubError();
  }
  if (!permissionAtLeast(permission, need)) {
    throw new HttpError('forbidden', need === 'write' ? NO_WRITE : NO_READ);
  }
  return repo;
}

/** View a repo, its PRs and reviews (and retry/cancel/rerun): org owner/admin or GitHub `read`+. */
export function requireRepoAccess(userId: string, repoId: string) {
  return requireRepoPermission(userId, repoId, 'read');
}

/** Change settings, rotate the ingest token, open the workflow PR, merge: owner/admin or `write`+. */
export function requireRepoWrite(userId: string, repoId: string) {
  return requireRepoPermission(userId, repoId, 'write');
}

/**
 * Same rule as `requireRepoWrite`, without throwing: false on a GitHub error, a missing login or
 * a missing membership. For the settings page's `canEdit`.
 */
export async function canEditRepo(userId: string, repo: RepoWithInstallation): Promise<boolean> {
  try {
    const { role } = await requireOrgMember(userId, repo.orgId);
    if (isOrgAdmin(role)) return true;
    const login = await loginOf(userId);
    if (!login) return false;
    return permissionAtLeast(await permissionOn(repo, login), 'write');
  } catch {
    return false;
  }
}

/**
 * Repo ids of the org the user may see: all of them for owner/admin; otherwise those with GitHub
 * `read`+ (at most 5 lookups at a time). A repo whose lookup errors is left out. Throws 403 unless
 * the user is an org member.
 */
export async function visibleRepoIds(userId: string, orgId: string): Promise<string[]> {
  const { role } = await requireOrgMember(userId, orgId);
  if (isOrgAdmin(role)) {
    const repos = await prisma.repo.findMany({ where: { orgId }, select: { id: true } });
    return repos.map((r) => r.id);
  }

  const login = await loginOf(userId);
  if (!login) return [];

  const repos = await prisma.repo.findMany({ where: { orgId }, include: { installation: true } });
  const visible = new Array<boolean>(repos.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const i = next++;
      const repo = repos[i]!;
      try {
        visible[i] = permissionAtLeast(await permissionOn(repo, login), 'read');
      } catch (err) {
        logger.warn(
          { userId, repoId: repo.id, err: err instanceof Error ? err.message : String(err) },
          'GitHub repo permission check failed; hiding repo',
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VISIBLE_REPOS_CONCURRENCY, repos.length) }, worker),
  );
  return repos.filter((_, i) => visible[i]).map((r) => r.id);
}

export async function requirePullAccess(userId: string, repoId: string, number: number) {
  return pullOf(await requireRepoAccess(userId, repoId), number);
}

export async function requirePullWrite(userId: string, repoId: string, number: number) {
  return pullOf(await requireRepoWrite(userId, repoId), number);
}

async function pullOf(repo: RepoWithInstallation, number: number) {
  const pull = await prisma.pullRequest.findUnique({
    where: { repoId_number: { repoId: repo.id, number } },
  });
  if (!pull) throw new HttpError('not_found', 'Pull request not found');
  return { repo, pull };
}

export async function requireReviewAccess(userId: string, reviewId: string) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: { pullRequest: { include: { repo: true } } },
  });
  if (!review) throw new HttpError('not_found', 'Review not found');
  await requireRepoAccess(userId, review.pullRequest.repo.id);
  return review;
}

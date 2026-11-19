import 'server-only';
import {
  fetchRepoPermission,
  getInstallationOctokit,
  permissionAtLeast,
  type RepoPermission,
} from '@app/github';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';

export { permissionAtLeast, type RepoPermission };

/** How long a GitHub repo permission is trusted before we ask GitHub again. */
export const REPO_PERMISSION_TTL_SECONDS = 300;

const VALUES: readonly string[] = ['admin', 'maintain', 'write', 'triage', 'read', 'none'];

function cacheKey(githubRepoId: number, login: string): string {
  return `gh:perm:${githubRepoId}:${login.toLowerCase()}`;
}

export interface GetRepoPermissionInput {
  githubInstallationId: number;
  githubRepoId: number;
  /** `owner/repo` */
  fullName: string;
  /** The user's GitHub login. */
  login: string;
}

/**
 * The user's permission on one repo, as GitHub reports it to our installation. Cached in Redis
 * for 5 minutes (including `'none'`). Errors are never cached and reach the caller, which must fail
 * closed. If Redis is unavailable the cache is skipped and GitHub is asked directly.
 */
export async function getRepoPermission(input: GetRepoPermissionInput): Promise<RepoPermission> {
  const key = cacheKey(input.githubRepoId, input.login);

  try {
    const hit = await getRedis().get(key);
    if (hit !== null && VALUES.includes(hit)) return hit as RepoPermission;
  } catch (err) {
    logger.warn(
      { githubRepoId: input.githubRepoId, err: (err as Error).message },
      'repo permission cache read failed',
    );
  }

  const octokit = await getInstallationOctokit(input.githubInstallationId);
  const permission = await fetchRepoPermission(octokit, input.fullName, input.login);

  try {
    await getRedis().set(key, permission, 'EX', REPO_PERMISSION_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      { githubRepoId: input.githubRepoId, err: (err as Error).message },
      'repo permission cache write failed',
    );
  }
  return permission;
}

/** Drops the cached permission so the next check asks GitHub (e.g. after a `member` webhook). */
export async function invalidateRepoPermission(githubRepoId: number, login: string): Promise<void> {
  try {
    await getRedis().del(cacheKey(githubRepoId, login));
  } catch (err) {
    // The entry expires on its own within the TTL.
    logger.warn(
      { githubRepoId, err: (err as Error).message },
      'repo permission cache delete failed',
    );
  }
}

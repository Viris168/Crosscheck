import 'server-only';
import {
  fetchRepoPermission,
  getInstallationOctokit,
  isRepoCollaborator,
  permissionAtLeast,
  type RepoPermission,
} from '@app/github';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';

export { permissionAtLeast, type RepoPermission };

/** How long a GitHub repo permission or collaborator answer is trusted before we ask GitHub again. */
export const REPO_PERMISSION_TTL_SECONDS = 300;

const VALUES: readonly string[] = ['admin', 'maintain', 'write', 'triage', 'read', 'none'];

function cacheKey(githubRepoId: number, login: string): string {
  return `gh:perm:${githubRepoId}:${login.toLowerCase()}`;
}

function collaboratorKey(githubRepoId: number, login: string): string {
  return `gh:collab:${githubRepoId}:${login.toLowerCase()}`;
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
 * Reads `key` from Redis (accepting only values `parse` understands), otherwise calls `load` and
 * caches its answer for the TTL. Errors from `load` are never cached and reach the caller, which
 * must fail closed. If Redis is unavailable the cache is skipped.
 */
async function cached<T extends string>(
  key: string,
  githubRepoId: number,
  parse: (value: string) => T | undefined,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await getRedis().get(key);
    const value = hit === null ? undefined : parse(hit);
    if (value !== undefined) return value;
  } catch (err) {
    logger.warn({ githubRepoId, err: (err as Error).message }, 'repo permission cache read failed');
  }

  const value = await load();

  try {
    await getRedis().set(key, value, 'EX', REPO_PERMISSION_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      { githubRepoId, err: (err as Error).message },
      'repo permission cache write failed',
    );
  }
  return value;
}

/**
 * The user's permission on one repo, as GitHub reports it to our installation. Cached in Redis
 * for 5 minutes (including `'none'`). Note GitHub reports `read` to every user on a public repo;
 * use `getRepoCollaborator` to decide who may see a repo.
 */
export async function getRepoPermission(input: GetRepoPermissionInput): Promise<RepoPermission> {
  return cached(
    cacheKey(input.githubRepoId, input.login),
    input.githubRepoId,
    (v) => (VALUES.includes(v) ? (v as RepoPermission) : undefined),
    async () => {
      const octokit = await getInstallationOctokit(input.githubInstallationId);
      return fetchRepoPermission(octokit, input.fullName, input.login);
    },
  );
}

/**
 * Whether GitHub lists the user as a collaborator on the repo: someone given access on purpose
 * (personal repo collaborators; for org repos also members with access via a team, the base
 * permission or ownership). Unlike `getRepoPermission`, a public repo doesn't make everyone count.
 * Cached like `getRepoPermission` (including `false`).
 */
export async function getRepoCollaborator(input: GetRepoPermissionInput): Promise<boolean> {
  const answer = await cached(
    collaboratorKey(input.githubRepoId, input.login),
    input.githubRepoId,
    (v) => (v === 'yes' || v === 'no' ? v : undefined),
    async () => {
      const octokit = await getInstallationOctokit(input.githubInstallationId);
      return (await isRepoCollaborator(octokit, input.fullName, input.login)) ? 'yes' : 'no';
    },
  );
  return answer === 'yes';
}

/** Drops the cached answers so the next check asks GitHub (e.g. after a `member` webhook). */
export async function invalidateRepoPermission(githubRepoId: number, login: string): Promise<void> {
  try {
    await getRedis().del(cacheKey(githubRepoId, login), collaboratorKey(githubRepoId, login));
  } catch (err) {
    // The entry expires on its own within the TTL.
    logger.warn(
      { githubRepoId, err: (err as Error).message },
      'repo permission cache delete failed',
    );
  }
}

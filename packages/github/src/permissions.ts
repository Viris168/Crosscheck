import { ProviderError } from '@app/shared';
import { splitFullName } from './fetch';
import { createOctokit, type Octokit } from './octokit';

/** A user's access to one repo on GitHub, low to high: none < read < triage < write < maintain < admin. */
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

const ORDER: readonly RepoPermission[] = ['none', 'read', 'triage', 'write', 'maintain', 'admin'];

/** True when `have` is at least `need` in the order none < read < triage < write < maintain < admin. */
export function permissionAtLeast(have: RepoPermission, need: RepoPermission): boolean {
  return ORDER.indexOf(have) >= ORDER.indexOf(need);
}

function isRepoPermission(value: unknown): value is RepoPermission {
  return typeof value === 'string' && (ORDER as readonly string[]).includes(value);
}

/**
 * A GitHub API failure from the permission helpers. It is a `ProviderError('github_error')` (so
 * `toGithubError` passes it through unchanged) that also carries the HTTP `status` (undefined on a
 * network error). Callers branch on it, e.g. `err instanceof GithubApiError && err.status === 403`.
 */
export class GithubApiError extends ProviderError {
  constructor(
    public readonly status: number | undefined,
    what: string,
  ) {
    super('github_error', `GitHub API error (${status ?? 'network'}) on ${what}`);
    this.name = 'GithubApiError';
  }
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    return err.status;
  }
  return undefined;
}

function toApiError(err: unknown, what: string): GithubApiError {
  if (err instanceof GithubApiError) return err;
  return new GithubApiError(statusOf(err), what);
}

/**
 * GET /repos/{owner}/{repo}/collaborators/{username}/permission. A 404 maps to `'none'`.
 *
 * Uses `role_name` (which knows `maintain` / `triage`) and falls back to the coarser `permission`
 * for custom repo roles or anything unknown. An unknown `permission` also maps to `'none'`.
 *
 * Note: on a public repo GitHub reports `read` for every user. Never use `!== 'none'` to decide
 * membership; use `isRepoCollaborator` for that.
 *
 * @throws GithubApiError on any non-404 failure (read `.status`).
 */
// VERIFY: works with an installation token (Metadata: read) for private repos.
export async function fetchRepoPermission(
  octokit: Octokit,
  fullName: string,
  login: string,
): Promise<RepoPermission> {
  const { owner, repo } = splitFullName(fullName);
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: login,
    });
    const roleName: unknown = (data as { role_name?: unknown }).role_name;
    if (isRepoPermission(roleName)) return roleName;
    return isRepoPermission(data.permission) ? data.permission : 'none';
  } catch (err) {
    if (statusOf(err) === 404) return 'none';
    throw toApiError(err, `repos.getCollaboratorPermissionLevel ${fullName}`);
  }
}

/**
 * GET /repos/{owner}/{repo}/collaborators/{username}. true on 204, false on 404.
 * Unlike `fetchRepoPermission`, this is false for strangers on a public repo.
 *
 * @throws GithubApiError on any other failure (read `.status`).
 */
// VERIFY: works with an installation token (Metadata: read).
export async function isRepoCollaborator(
  octokit: Octokit,
  fullName: string,
  login: string,
): Promise<boolean> {
  const { owner, repo } = splitFullName(fullName);
  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo, username: login });
    return true;
  } catch (err) {
    if (statusOf(err) === 404) return false;
    throw toApiError(err, `repos.checkCollaborator ${fullName}`);
  }
}

/**
 * GET /orgs/{org}/memberships/{username}. Returns null when the user is not an active member
 * (404, state `pending`, or a non-member role such as `billing_manager`).
 *
 * @throws GithubApiError on any other failure. A missing "Organization → Members: read"
 *   permission surfaces as `err.status === 403`; H2 uses that to set `needsMemberPermission`.
 */
// VERIFY: needs Organization → Members: read on the installation; GitHub answers 403 (not 404)
//         while that permission is not granted.
export async function fetchOrgMembership(
  octokit: Octokit,
  org: string,
  login: string,
): Promise<{ role: 'admin' | 'member' } | null> {
  try {
    const { data } = await octokit.rest.orgs.getMembershipForUser({ org, username: login });
    if (data.state !== 'active') return null;
    if (data.role === 'admin' || data.role === 'member') return { role: data.role };
    return null;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw toApiError(err, `orgs.getMembershipForUser ${org}`);
  }
}

const PER_PAGE = 100;

/**
 * GET /user/installations with a user-to-server token (all pages). Returns the installation ids
 * of this GitHub App that the user can access. Builds its own Octokit from the token (no app JWT).
 *
 * @throws GithubApiError on failure (e.g. `.status === 401` for an expired token).
 */
// VERIFY: works with the GitHub App user token Better Auth stores for the github provider.
export async function listUserInstallationIds(
  userToken: string,
  options: { octokit?: Octokit } = {},
): Promise<number[]> {
  const octokit = options.octokit ?? createOctokit({ auth: userToken });
  const ids: number[] = [];
  try {
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.apps.listInstallationsForAuthenticatedUser({
        per_page: PER_PAGE,
        page,
      });
      for (const inst of data.installations) ids.push(inst.id);
      if (data.installations.length < PER_PAGE) break;
    }
  } catch (err) {
    throw toApiError(err, 'apps.listInstallationsForAuthenticatedUser');
  }
  return ids;
}

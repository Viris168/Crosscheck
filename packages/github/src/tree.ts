// GitHub REST reads for the branch tree (tasks/T2b-github-reads.md, spec: tasks/T-branch-tree.md).
// No compare endpoints: ahead/behind/merge-base come from the commits-only clone, never from GitHub.
import type { CiState } from '@app/shared';
import { splitFullName, toGithubError } from './fetch';
import { getAppOctokit, type Octokit } from './octokit';

const PER_PAGE = 100;

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    return err.status;
  }
  return undefined;
}

// ---------------------------------------------------------------- logging

/** pino-compatible `warn(obj, msg)`. Defaults to `console.warn`. */
export type TreeWarn = (obj: { fullName: string; reason: string }, msg: string) => void;

const defaultWarn: TreeWarn = (obj, msg) =>
  console.warn(JSON.stringify({ level: 'warn', ...obj, msg }));

/** `${fullName}\0${reason}` pairs already logged by this process. */
const loggedOnce = new Set<string>();

function warnOnce(warn: TreeWarn, fullName: string, reason: string, msg: string): void {
  const key = `${fullName}\0${reason}`;
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  warn({ fullName, reason }, msg);
}

/** Test helper: forget which "log once" warnings were already written. */
export function resetTreeWarningsForTesting(): void {
  loggedOnce.clear();
}

// ---------------------------------------------------------------- branches

export interface TreeBranch {
  name: string;
  headSha: string;
  protected: boolean;
}

/** All branches (paginated, 100 per page): name, head sha, protected. Plus the repo's default branch. */
export async function listBranches(
  octokit: Octokit,
  fullName: string,
): Promise<{ defaultBranch: string; branches: TreeBranch[] }> {
  const { owner, repo } = splitFullName(fullName);

  let defaultBranch: string;
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    defaultBranch = data.default_branch;
  } catch (err) {
    throw toGithubError(err, `repos.get ${fullName}`);
  }

  const branches: TreeBranch[] = [];
  try {
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.repos.listBranches({
        owner,
        repo,
        per_page: PER_PAGE,
        page,
      });
      for (const b of data) {
        branches.push({ name: b.name, headSha: b.commit.sha, protected: b.protected });
      }
      if (data.length < PER_PAGE) break;
    }
  } catch (err) {
    throw toGithubError(err, `repos.listBranches ${fullName}`);
  }
  return { defaultBranch, branches };
}

// ---------------------------------------------------------------- pull requests

export interface TreePr {
  number: number;
  /** `merged` when GitHub reports `merged_at`; otherwise GitHub's `open` / `closed`. */
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** ISO timestamp, or null when not merged. */
  mergedAt: string | null;
  /**
   * After a merge commit: the merge commit. After a squash: the squashed commit on the base. After a
   * rebase merge: the commit the base branch was updated to, i.e. the last rebased commit (GitHub REST
   * "Get a pull request"). Before merging GitHub fills it with a test merge commit, so only trust it
   * when `state === 'merged'`. Stored for the UI link only.
   */
  mergeCommitSha: string | null;
  title: string;
  author: string;
  /** ISO timestamp. */
  updatedAt: string;
}

export interface ListPullRequestsForTreeOptions {
  /** Pages of 100 to read at most. Default 10 (= 1000 PRs). */
  maxPages?: number;
}

/** All PRs (state=all), newest first, paginated, stopping after `maxPages` (default 10 = 1000 PRs). */
export async function listPullRequestsForTree(
  octokit: Octokit,
  fullName: string,
  opts: ListPullRequestsForTreeOptions = {},
): Promise<TreePr[]> {
  const { owner, repo } = splitFullName(fullName);
  const maxPages = opts.maxPages ?? 10;
  const prs: TreePr[] = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
      });
      for (const p of data) {
        prs.push({
          number: p.number,
          state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
          headRef: p.head.ref,
          headSha: p.head.sha,
          baseRef: p.base.ref,
          baseSha: p.base.sha,
          mergedAt: p.merged_at ?? null,
          mergeCommitSha: p.merge_commit_sha ?? null,
          title: p.title,
          author: p.user?.login ?? 'ghost',
          updatedAt: p.updated_at,
        });
      }
      if (data.length < PER_PAGE) break;
    }
  } catch (err) {
    throw toGithubError(err, `pulls.list ${fullName}`);
  }
  return prs;
}

// ---------------------------------------------------------------- CI state

/** The non-`none` CI buckets. `counts` always has all four keys. */
export type CiBucket = Exclude<CiState, 'none'>;

/**
 * Maps one check-run status/conclusion or one commit-status state to a bucket (T-spec "CI state").
 * Exported for tests and for webhook handlers that see a single check run / status.
 */
// VERIFY: `action_required` / `startup_failure` (not in the T-spec table) → failure, like GitHub's
//         red X; `stale` (GitHub marked an old check stale) → neutral.
export function ciBucket(value: string | null | undefined): CiBucket {
  switch (value) {
    case 'failure':
    case 'cancelled':
    case 'timed_out':
    case 'error':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    case 'queued':
    case 'in_progress':
    case 'pending':
    case 'waiting':
    case 'requested':
      return 'pending';
    case 'success':
      return 'success';
    case 'neutral':
    case 'skipped':
    case 'stale':
      return 'neutral';
    default:
      // A completed run with no conclusion yet, or a value GitHub adds later.
      return 'pending';
  }
}

/** Combines bucket counts: any failure → failure; else any pending → pending; else any success →
 * success; only neutral → neutral; nothing → none. */
export function combineCi(counts: Record<CiBucket, number>): CiState {
  if (counts.failure > 0) return 'failure';
  if (counts.pending > 0) return 'pending';
  if (counts.success > 0) return 'success';
  if (counts.neutral > 0) return 'neutral';
  return 'none';
}

export interface FetchCiStateOptions {
  warn?: TreeWarn;
}

/**
 * Check runs (`GET /repos/{r}/commits/{sha}/check-runs`, paginated) + commit statuses
 * (`GET /repos/{r}/commits/{sha}/status`, latest per context, paginated) for one SHA, combined per
 * the T-spec "CI state" rule. `counts` is by bucket (success / failure / pending / neutral).
 *
 * A 403 on either endpoint (the installation has not accepted the new permission yet) counts that
 * source as empty and logs `{ fullName, reason: 'statuses_forbidden' | 'checks_forbidden' }` once per
 * process. Any other failure → `ProviderError('github_error')`.
 */
export async function fetchCiState(
  octokit: Octokit,
  fullName: string,
  sha: string,
  opts: FetchCiStateOptions = {},
): Promise<{ state: CiState; counts: Record<CiBucket, number> }> {
  const { owner, repo } = splitFullName(fullName);
  const warn = opts.warn ?? defaultWarn;
  const counts: Record<CiBucket, number> = { success: 0, failure: 0, pending: 0, neutral: 0 };

  // Check runs.
  try {
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: sha,
        per_page: PER_PAGE,
        page,
      });
      for (const run of data.check_runs) {
        counts[ciBucket(run.status === 'completed' ? run.conclusion : run.status)]++;
      }
      if (data.check_runs.length < PER_PAGE) break;
    }
  } catch (err) {
    if (statusOf(err) !== 403) throw toGithubError(err, `checks.listForRef ${fullName}`);
    warnOnce(warn, fullName, 'checks_forbidden', 'check runs forbidden; treating as empty');
  }

  // Commit statuses (the combined endpoint already keeps only the latest status per context).
  try {
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: sha,
        per_page: PER_PAGE,
        page,
      });
      for (const s of data.statuses) counts[ciBucket(s.state)]++;
      if (data.statuses.length < PER_PAGE) break;
    }
  } catch (err) {
    if (statusOf(err) !== 403)
      throw toGithubError(err, `repos.getCombinedStatusForRef ${fullName}`);
    warnOnce(warn, fullName, 'statuses_forbidden', 'commit statuses forbidden; treating as empty');
  }

  return { state: combineCi(counts), counts };
}

// ---------------------------------------------------------------- git auth

export interface GitAuth {
  /** `https://github.com/<owner>/<repo>.git`. Never contains the token. */
  url: string;
  /** Pass to every git call: sets `http.https://github.com/.extraheader` without touching `.git/config`. */
  env: Record<string, string>;
  expiresAt: Date;
}

export interface GitAuthRepo {
  /** GitHub's numeric repo id (`Repo.githubRepoId`), used to scope the token. */
  githubRepoId: number;
  fullName: string;
}

export interface GitAuthOptions {
  /** App-authenticated (JWT) client. Default `getAppOctokit()`. */
  appOctokit?: Octokit;
}

/**
 * A short-lived installation token for git, scoped to one repo with `contents: read` +
 * `metadata: read`, handed to git through `GIT_CONFIG_COUNT/KEY/VALUE` env. The token never appears
 * in `url`, in `.git/config`, or in a thrown error message.
 *
 * Takes the repo as a second argument (the T2b task signature had only `installationId`): the token
 * is scoped with `repository_ids` and the clone URL needs the repo name.
 */
// VERIFY: POST /app/installations/{id}/access_tokens accepts `repository_ids` + `permissions`
//         `{ contents: 'read', metadata: 'read' }` and returns `{ token, expires_at }`.
export async function gitAuthForInstallation(
  installationId: number,
  repo: GitAuthRepo,
  opts: GitAuthOptions = {},
): Promise<GitAuth> {
  const { owner, repo: name } = splitFullName(repo.fullName);
  let token: string;
  let expiresAt: string;
  try {
    const app = opts.appOctokit ?? getAppOctokit();
    const { data } = await app.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
      repository_ids: [repo.githubRepoId],
      permissions: { contents: 'read', metadata: 'read' },
    });
    token = data.token;
    expiresAt = data.expires_at;
  } catch (err) {
    throw toGithubError(err, `apps.createInstallationAccessToken ${installationId}`);
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    url: `https://github.com/${owner}/${name}.git`,
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
    expiresAt: new Date(expiresAt),
  };
}

import { ProviderError, type ReviewFile } from '@app/shared';
import type { Octokit } from './octokit';

/** GitHub stops listing PR files at 3000. */
export const MAX_PR_FILES = 3000;
const PER_PAGE = 100;

export interface PrMeta {
  number: number;
  title: string;
  body: string;
  author: string;
  /** GitHub's state; `merged` is true for merged (closed) PRs. */
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    return err.status;
  }
  return undefined;
}

/** Maps any Octokit failure to `ProviderError('github_error')`. Never includes tokens/bodies. */
export function toGithubError(err: unknown, what: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = statusOf(err);
  return new ProviderError('github_error', `GitHub API error (${status ?? 'network'}) on ${what}`);
}

export async function fetchPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PrMeta> {
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      author: data.user?.login ?? 'ghost',
      state: data.state === 'closed' ? 'closed' : 'open',
      merged: data.merged ?? false,
      draft: data.draft ?? false,
      headSha: data.head.sha,
      headRef: data.head.ref,
      baseRef: data.base.ref,
      baseSha: data.base.sha,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changed_files ?? 0,
    };
  } catch (err) {
    throw toGithubError(err, `pulls.get ${owner}/${repo}#${number}`);
  }
}

function mapStatus(status: string): ReviewFile['status'] {
  switch (status) {
    case 'added':
    case 'copied':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    default:
      // modified | changed | unchanged
      return 'modified';
  }
}

/**
 * Lists every changed file of a PR (100 per page, up to GitHub's 3000-file cap).
 * Files without a patch (binary / too large) get `patch: ''`.
 */
export async function fetchPullRequestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewFile[]> {
  const files: ReviewFile[] = [];
  try {
    for (let page = 1; files.length < MAX_PR_FILES; page++) {
      const { data } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: number,
        per_page: PER_PAGE,
        page,
      });
      for (const f of data) {
        files.push({ path: f.filename, status: mapStatus(f.status), patch: f.patch ?? '' });
      }
      if (data.length < PER_PAGE) break;
    }
  } catch (err) {
    throw toGithubError(err, `pulls.listFiles ${owner}/${repo}#${number}`);
  }
  return files.slice(0, MAX_PR_FILES);
}

/**
 * Text of one file at `ref` (e.g. AGENTS.md, CHANGE_NOTES.md). `null` if it does not exist or is
 * not a regular file.
 */
export async function fetchFileText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
    const encoding = data.encoding as string;
    if (encoding === 'base64') return Buffer.from(data.content, 'base64').toString('utf8');
    // Files > 1 MB come back with encoding "none" and no content.
    return null;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw toGithubError(err, `repos.getContent ${owner}/${repo}`);
  }
}

/** `"owner/repo"` → `{ owner, repo }`. Throws on anything else. */
export function splitFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) {
    throw new Error(`Invalid repository full name: ${JSON.stringify(fullName)}`);
  }
  return { owner, repo };
}

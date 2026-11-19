import type { Octokit } from './octokit';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** Why GitHub refused a merge. `message` is GitHub's own text (e.g. a branch-protection rule). */
export type MergeFailureReason =
  | 'not_mergeable' // 405: conflicts, failing required checks, method not allowed
  | 'head_changed' // 409: the head moved past `sha`
  | 'forbidden' // 403: the App lacks Contents: write, or a ruleset blocks it
  | 'not_found'; // 404

export class MergeError extends Error {
  constructor(
    public readonly reason: MergeFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

const REASONS: Record<number, MergeFailureReason> = {
  403: 'forbidden',
  404: 'not_found',
  405: 'not_mergeable',
  409: 'head_changed',
  422: 'not_mergeable',
};

function githubMessage(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('response' in err)) return undefined;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') {
    return data.message.slice(0, 300);
  }
  return undefined;
}

/**
 * PUT /repos/{owner}/{repo}/pulls/{number}/merge. `sha` pins the merge to the reviewed head:
 * GitHub answers 409 if the branch moved. Branch protection and rulesets still apply.
 * Known refusals throw `MergeError`; anything else is rethrown as-is.
 */
export async function mergePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  opts: { sha: string; method: MergeMethod },
): Promise<{ sha: string }> {
  try {
    const { data } = await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: number,
      sha: opts.sha,
      merge_method: opts.method,
      // A refusal (405/409) is an answer, not a transient error.
      request: { retries: 0 },
    });
    return { sha: data.sha };
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    const reason = typeof status === 'number' ? REASONS[status] : undefined;
    if (!reason) throw err;
    throw new MergeError(reason, githubMessage(err) ?? `GitHub refused the merge (${status})`);
  }
}

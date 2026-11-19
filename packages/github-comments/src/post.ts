import { LIMITS, ProviderError, type ReviewFile, type ReviewIssue } from '@app/shared';
import { rightSideLines } from './diff';
import { OUTDATED_PREFIX, SUMMARY_MARKER, formatIssueComment, formatOverflowList } from './format';

/**
 * The slice of Octokit (`@app/github`'s `Octokit`) that posting a review needs. Kept structural so
 * this package has no runtime dependency on the GitHub client and is easy to mock.
 */
export interface ReviewOctokit {
  rest: {
    pulls: {
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        event: 'COMMENT';
        body: string;
        comments: ReviewComment[];
      }): Promise<{ data: { id: number } }>;
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          id: number;
          body?: string | null;
          commit_id?: string | null;
          user?: { type?: string } | null;
        }>;
      }>;
      updateReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        review_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface PostReviewArgs {
  /** `owner/repo` */
  fullName: string;
  prNumber: number;
  headSha: string;
  files: ReviewFile[];
  issues: ReviewIssue[];
  /** Usually from `formatSummary`. */
  summaryBody: string;
}

export interface InlineSelection {
  /** Indexes into `issues` that will be posted inline (in diff, first `maxInlineComments`). */
  inline: number[];
  /** In the diff but over the inline cap — listed in the summary. */
  overflow: number[];
  /** File/line not in the PR diff — dropped. */
  outOfDiff: number[];
}

/** Splits issues into inline / over-the-cap / not-in-diff. Order of `issues` is kept. */
export function selectInlineIssues(
  files: ReviewFile[],
  issues: ReviewIssue[],
  max: number = LIMITS.maxInlineComments,
): InlineSelection {
  const linesByPath = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.status !== 'removed') linesByPath.set(f.path, rightSideLines(f.patch));
  }
  const result: InlineSelection = { inline: [], overflow: [], outOfDiff: [] };
  issues.forEach((issue, i) => {
    if (!linesByPath.get(issue.file)?.has(issue.line)) result.outOfDiff.push(i);
    else if (result.inline.length < max) result.inline.push(i);
    else result.overflow.push(i);
  });
  return result;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    return err.status;
  }
  return undefined;
}

/** Text of a GitHub 422 error (message + `errors[]`), used to find the offending comment. */
function errorText(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const parts: string[] = [];
  if ('message' in err && typeof err.message === 'string') parts.push(err.message);
  const data =
    'response' in err ? (err.response as { data?: unknown } | undefined)?.data : undefined;
  if (data && typeof data === 'object' && 'errors' in data && Array.isArray(data.errors)) {
    for (const e of data.errors) parts.push(typeof e === 'string' ? e : JSON.stringify(e));
  }
  return parts.join('\n');
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0)
    throw new ProviderError('internal', 'Invalid repo full name');
  return { owner, repo };
}

function withMarker(body: string): string {
  return body.includes(SUMMARY_MARKER) ? body : `${SUMMARY_MARKER}\n${body}`;
}

function buildBody(summaryBody: string, notInline: ReviewIssue[]): string {
  const overflow = formatOverflowList(notInline);
  return withMarker(overflow ? `${summaryBody}\n\n${overflow}` : summaryBody);
}

/**
 * Posts ONE review (`event: COMMENT`) with inline comments on the PR head commit.
 * - Issues whose file/line is not in the diff are skipped; at most 50 go inline, the rest are listed
 *   in the summary body.
 * - On 422, retries once without the offending comment(s) (or without any inline comments when
 *   GitHub does not say which one failed).
 * - Afterwards, our earlier summary reviews on other commits get an "Outdated" prefix (best effort).
 */
export async function postReview(
  octokit: ReviewOctokit,
  args: PostReviewArgs,
): Promise<{ githubReviewId: number; postedIssueIndexes: number[] }> {
  const { owner, repo } = splitFullName(args.fullName);
  const sel = selectInlineIssues(args.files, args.issues);

  const attempt = (inline: number[], notInline: number[]) =>
    octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: args.prNumber,
      commit_id: args.headSha,
      event: 'COMMENT',
      body: buildBody(
        args.summaryBody,
        notInline.map((i) => args.issues[i]!),
      ),
      comments: inline.map((i) => {
        const issue = args.issues[i]!;
        return {
          path: issue.file,
          line: issue.line,
          side: 'RIGHT',
          body: formatIssueComment(issue),
        };
      }),
    });

  let posted = sel.inline;
  let githubReviewId: number;
  try {
    githubReviewId = (await attempt(posted, sel.overflow)).data.id;
  } catch (err) {
    if (statusOf(err) !== 422 || posted.length === 0) {
      throw new ProviderError(
        'github_error',
        `GitHub API error (${statusOf(err) ?? 'network'}) on pulls.createReview`,
      );
    }
    const text = errorText(err);
    const named = posted.filter((i) => text.includes(args.issues[i]!.file));
    const dropped = named.length > 0 && named.length < posted.length ? named : posted;
    posted = posted.filter((i) => !dropped.includes(i));
    const notInline = [...dropped, ...sel.overflow].sort((a, b) => a - b);
    try {
      githubReviewId = (await attempt(posted, notInline)).data.id;
    } catch (retryErr) {
      throw new ProviderError(
        'github_error',
        `GitHub API error (${statusOf(retryErr) ?? 'network'}) on pulls.createReview retry`,
      );
    }
  }

  await markPreviousOutdated(octokit, { owner, repo, args, newReviewId: githubReviewId });
  return { githubReviewId, postedIssueIndexes: posted };
}

async function markPreviousOutdated(
  octokit: ReviewOctokit,
  ctx: { owner: string; repo: string; args: PostReviewArgs; newReviewId: number },
): Promise<void> {
  const { owner, repo, args, newReviewId } = ctx;
  try {
    // VERIFY: a PR with > 100 reviews only gets its first page checked.
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: args.prNumber,
      per_page: 100,
    });
    const link = `https://github.com/${owner}/${repo}/pull/${args.prNumber}#pullrequestreview-${newReviewId}`;
    for (const r of data) {
      const body = r.body ?? '';
      if (
        r.id === newReviewId ||
        r.commit_id === args.headSha ||
        !body.includes(SUMMARY_MARKER) ||
        body.startsWith(OUTDATED_PREFIX) ||
        (r.user?.type !== undefined && r.user.type !== 'Bot')
      ) {
        continue;
      }
      await octokit.rest.pulls.updateReview({
        owner,
        repo,
        pull_number: args.prNumber,
        review_id: r.id,
        body: `${OUTDATED_PREFIX} ([newer review](${link}))\n\n${body}`,
      });
    }
  } catch {
    // Best effort: the new review is already posted; a stale old summary is cosmetic.
  }
}

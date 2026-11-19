// Mock of `@app/github-comments` (lane E) with the signatures from tasks/E-scoring-comments.md.
// TODO(lane E): delete this file and import from '@app/github-comments' in ../deps.ts.
import type { Octokit } from '@app/github';
import type { ProviderId, ReviewFile, ReviewIssue, RiskResult } from '@app/shared';

/** True if `line` (new-file numbering, RIGHT side) is an added or context line of a hunk. */
export function isLineInDiff(patch: string, line: number): boolean {
  let next = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      next = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue;
    if (raw.startsWith('-')) continue;
    if (raw.startsWith('+') || raw.startsWith(' ') || raw === '') {
      if (next === line) return true;
      next++;
    }
  }
  return false;
}

export function formatSummary(args: {
  risk: RiskResult;
  summary: string;
  issueCount: number;
  postedCount: number;
  provider: ProviderId;
  dashboardUrl: string;
}): string {
  return [
    `**AI review** — risk ${args.risk.score} (${args.risk.level})`,
    `${args.issueCount} issues, ${args.postedCount} posted inline.`,
    `[Open in dashboard](${args.dashboardUrl})`,
  ].join('\n\n');
}

/** No-op: posts nothing. `githubReviewId: 0` means "not posted". */
export async function postReview(
  _octokit: Octokit,
  _args: {
    fullName: string;
    prNumber: number;
    headSha: string;
    files: ReviewFile[];
    issues: ReviewIssue[];
    summaryBody: string;
  },
): Promise<{ githubReviewId: number; postedIssueIndexes: number[] }> {
  return { githubReviewId: 0, postedIssueIndexes: [] };
}

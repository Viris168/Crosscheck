# Task E — Risk scoring + GitHub comments

**Branch:** `feat/e-scoring` · **Phase 2** · **Depends on:** Foundation, A (`@app/github`)

## Goal
Turn findings + PR metadata into one consistent risk score, and post findings as a clean GitHub review
with inline comments and one-click suggestions.

## You own
- `packages/scoring/` → `@app/scoring`
- `packages/github-comments/` → `@app/github-comments`

## Do not touch
Anything else.

## Build

### `@app/scoring`
```ts
export function computeRisk(input: {
  aiScores: number[];                    // one per chunk (or one from Action result)
  issues: ReviewIssue[];
  pr: { additions: number; deletions: number; changedFiles: number };
  paths: string[];                       // changed file paths
}): RiskResult;
```
Score = clamp(0–100) of weighted parts. Start with these (constants in one file so they're easy to tune):
| Factor | Points |
|---|---|
| AI score (max of chunk scores) | × 0.4 |
| Each critical / high / medium issue | +15 / +8 / +3 (cap 40) |
| Lines changed > 500 / > 1500 | +5 / +10 |
| Sensitive paths (auth, payment, billing, migration, security, `.github/workflows`, Dockerfile, infra) | +10 |
| Source changed but no test files changed | +8 |
Level: < 25 low, < 50 medium, < 75 high, else critical. Return every factor that contributed with a
human label (shown in the UI).

### `@app/github-comments`
```ts
export function isLineInDiff(patch: string, line: number): boolean;          // RIGHT side, new-file line numbers
export function formatIssueComment(issue: ReviewIssue): string;              // markdown, escaped
export function formatSummary(args: { risk: RiskResult; summary: string; issueCount: number;
  postedCount: number; provider: ProviderId; dashboardUrl: string }): string;
export async function postReview(octokit, args: {
  fullName: string; prNumber: number; headSha: string;
  files: ReviewFile[]; issues: ReviewIssue[]; summaryBody: string;
}): Promise<{ githubReviewId: number; postedIssueIndexes: number[] }>;
```
- Comment body: severity badge + title, explanation, and if `suggested_fix` exists a ```` ```suggestion ````
  block (only when the fix is a replacement for that single line or a contiguous range you can express;
  otherwise a normal code block).
- Escape markdown/HTML in AI text; strip `@mentions` (backtick them) so the bot never pings people.
- One review per call: `event: 'COMMENT'`, `commit_id: headSha`, `comments[]` with `path`, `line`,
  `side: 'RIGHT'`. Skip issues not in diff. Max 50 inline comments; the rest are listed in the summary.
- On re-run for a newer commit: mark the previous bot review's summary as outdated (edit body prefix
  "Outdated — see newer review") rather than deleting.
- If GitHub returns 422 for a comment, retry once without that comment.
- Both packages are plain TypeScript (no Next.js / Inngest imports); lane B calls them from
  the `review-finalize` Inngest function.

## Tests
- `computeRisk` table tests for each factor and level boundaries
- `isLineInDiff` with multi-hunk patches, added/removed lines, renamed files
- Formatting: escaping, mention stripping, suggestion vs code block
- `postReview` with mocked Octokit: filters out-of-diff issues, caps at 50, 422 retry

## Done when
- [ ] All tests pass
- [ ] Manual: post a review with 3 sample issues on a test PR; suggestion button works on GitHub

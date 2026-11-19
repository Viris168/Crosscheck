// review-finalize: `review/finalize` (from review-start or ingest) → drop out-of-diff issues → risk →
// post the GitHub review → completed. Shared by the job path and the Action path.
import { LIMITS, Severity, type ErrorCode, type ReviewIssue } from '@app/shared';
import type { HandlerCtx, JobDeps } from './deps';
import { errorCodeOf, errorMessageOf, retriable } from './errors';
import { prRef, requireContext } from './review-start';
import type { StoredIssue } from './store';

export type ReviewFinalizeResult =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; errorCode: ErrorCode }
  | { status: 'completed'; issues: number; posted: number };

const rank = (s: Severity): number => Severity.indexOf(s);

function toIssue({ id: _id, ...issue }: StoredIssue): ReviewIssue {
  return issue;
}

/** Keeps issues on a diff line, most severe first (stable), capped at `max`. */
export function selectIssues(
  issues: readonly StoredIssue[],
  patches: ReadonlyMap<string, string>,
  isLineInDiff: (patch: string, line: number) => boolean,
  max: number,
): StoredIssue[] {
  return issues
    .filter((i) => {
      const patch = patches.get(i.file);
      return patch !== undefined && patch !== '' && isLineInDiff(patch, i.line);
    })
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => rank(b.issue.severity) - rank(a.issue.severity) || a.index - b.index)
    .slice(0, Math.max(0, max))
    .map((x) => x.issue);
}

function rethrowWithCode(err: unknown, fallback: ErrorCode): never {
  if (err instanceof Error && err.name === 'NonRetriableError') throw err;
  const code = errorCodeOf(err);
  throw retriable(code === 'internal' ? fallback : code, errorMessageOf(err));
}

export async function reviewFinalizeHandler(
  ctx: HandlerCtx<{ reviewId: string }>,
  deps: JobDeps,
): Promise<ReviewFinalizeResult> {
  const { step } = ctx;
  const { reviewId } = ctx.event.data;
  const log = deps.log;

  // 1. Load; exit if already completed (or failed / cancelled meanwhile).
  const loaded = await step.run('load', async () => {
    const c = await deps.store.getReviewContext(reviewId);
    if (!c) return { ok: false as const, reason: 'not_found' };
    if (c.review.status !== 'running' && c.review.status !== 'waiting_action') {
      return { ok: false as const, reason: `status_${c.review.status}` };
    }
    return { ok: true as const, repoId: c.repo.id };
  });
  if (!loaded.ok) {
    log.info({ reviewId, reason: loaded.reason }, 'review-finalize skipped');
    return { status: 'skipped', reason: loaded.reason };
  }
  const repoId = loaded.repoId;

  try {
    // 2 + 3. Drop out-of-diff issues, sort, cap (dropped issues are deleted), then compute risk.
    const scored = await step.run('score', async () => {
      try {
        const c = await requireContext(deps, reviewId);
        const files = await deps.github.listFiles(prRef(c));
        const patches = new Map(files.map((f) => [f.path, f.patch]));
        const issues = await deps.store.listIssues(reviewId);
        const kept = selectIssues(
          issues,
          patches,
          deps.isLineInDiff,
          c.repo.settings.maxIssuesPerPr,
        );
        const keptIds = new Set(kept.map((i) => i.id));
        const dropped = issues.filter((i) => !keptIds.has(i.id)).map((i) => i.id);
        await deps.store.deleteIssues(reviewId, dropped);
        // Before finalize, review.riskScore holds the AI's own score (see store.ts / PR notes).
        const risk = deps.computeRisk({
          aiScores: c.review.riskScore === null ? [] : [c.review.riskScore],
          issues: kept.map(toIssue),
          pr: {
            additions: c.pr.additions,
            deletions: c.pr.deletions,
            changedFiles: c.pr.changedFiles,
          },
          paths: files.map((f) => f.path),
        });
        await deps.store.saveRisk(reviewId, risk); // last write: a retry before it re-reads the AI score
        return { risk, kept: kept.length, dropped: dropped.length };
      } catch (err) {
        rethrowWithCode(err, 'internal');
      }
    });

    // 4. Post the GitHub review (minSeverity filter for posting; all issues stay in the DB).
    const posted = await step.run('post', async () => {
      try {
        const c = await requireContext(deps, reviewId);
        if (c.review.githubReviewId) return { githubReviewId: c.review.githubReviewId, posted: 0 };
        const ref = prRef(c);
        const files = await deps.github.listFiles(ref);
        const issues = await deps.store.listIssues(reviewId);
        const min = rank(c.repo.settings.minSeverity);
        const toPost = issues.filter((i) => rank(i.severity) >= min);
        const summaryBody = deps.formatSummary({
          risk: scored.risk,
          summary: c.review.summary ?? '',
          issueCount: issues.length,
          postedCount: Math.min(toPost.length, LIMITS.maxInlineComments),
          provider: c.review.provider,
          dashboardUrl: deps.dashboardUrl(c.repo.id, c.pr.number),
        });
        const res = await deps.github.postReview(ref, {
          headSha: c.review.headSha,
          files,
          issues: toPost.map(toIssue),
          summaryBody,
        });
        const postedIds = res.postedIssueIndexes
          .map((i) => toPost[i]?.id)
          .filter((id): id is string => id !== undefined);
        if (res.githubReviewId > 0) {
          await deps.store.markPosted(reviewId, res.githubReviewId, postedIds);
        }
        return { githubReviewId: res.githubReviewId, posted: postedIds.length };
      } catch (err) {
        rethrowWithCode(err, 'github_error');
      }
    });

    // 5. Done.
    await step.run('complete', () => deps.store.complete(reviewId, deps.now()));
    log.info(
      {
        reviewId,
        repoId,
        riskScore: scored.risk.score,
        issues: scored.kept,
        dropped: scored.dropped,
        posted: posted.posted,
      },
      'review completed',
    );
    return { status: 'completed', issues: scored.kept, posted: posted.posted };
  } catch (err) {
    const code = errorCodeOf(err);
    await step.run('fail', () => deps.store.fail(reviewId, code, errorMessageOf(err), deps.now()));
    log.error({ reviewId, repoId, errorCode: code }, 'review-finalize failed');
    return { status: 'failed', errorCode: code };
  }
}

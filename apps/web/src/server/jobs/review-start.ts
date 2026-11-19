// review-start: `review/requested` → plan → one step per chunk (provider call + save issues) → finalize.
// Step outputs are persisted by Inngest: they only ever carry ids, paths and counts.
import {
  IssueSchema,
  LIMITS,
  type ErrorCode,
  type ReviewChunkInput,
  type ReviewIssue,
} from '@app/shared';
import type { HandlerCtx, JobDeps, PrRef } from './deps';
import {
  errorCodeOf,
  errorMessageOf,
  mostSpecific,
  nonRetriable,
  providerFailure,
  retriable,
} from './errors';
import { planChunks, prepareFile, reviewableFiles, type ReviewPlan } from './planning';
import type { ReviewContext } from './store';

export const CONTEXT_FILES = { intentNotes: 'CHANGE_NOTES.md', guidelines: 'AGENTS.md' } as const;

/** Failed-file names listed in `errorMessage` (the rest are counted). */
const MAX_LISTED_PATHS = 10;

export type ReviewStartResult =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; errorCode: ErrorCode }
  | { status: 'finalizing'; chunks: number; failedChunks: number };

type ChunkOutcome =
  | { index: number; ok: true; files: number; issues: number; riskScore: number }
  | { index: number; ok: false; files: number; code: ErrorCode };

export function prRef(c: ReviewContext): PrRef {
  return {
    installationId: c.repo.githubInstallationId,
    fullName: c.repo.fullName,
    prNumber: c.pr.number,
  };
}

export async function requireContext(deps: JobDeps, reviewId: string): Promise<ReviewContext> {
  const c = await deps.store.getReviewContext(reviewId);
  if (!c) throw nonRetriable('internal', 'review not found');
  return c;
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ');
  const more = paths.length - MAX_LISTED_PATHS;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

function planWarning(plan: ReviewPlan): string | null {
  const notes: string[] = [];
  if (plan.tooLarge) {
    notes.push(
      `PR too large: reviewed ${plan.filesTotal} files (riskiest paths first); ${plan.skippedFiles} files were skipped.`,
    );
  }
  if (plan.truncatedFiles > 0) {
    notes.push(`${plan.truncatedFiles} large files were reviewed only partially (first hunks).`);
  }
  return notes.length > 0 ? notes.join(' ') : null;
}

export async function reviewStartHandler(
  ctx: HandlerCtx<{ reviewId: string; orgId: string }>,
  deps: JobDeps,
): Promise<ReviewStartResult> {
  const { step } = ctx;
  const { reviewId } = ctx.event.data;
  const log = deps.log;

  // 1. Load. Anything but `queued` (cancelled, already running from a duplicate event…) → no-op.
  const loaded = await step.run('load', async () => {
    const c = await deps.store.getReviewContext(reviewId);
    if (!c) return { ok: false as const, reason: 'not_found' };
    if (c.review.status !== 'queued')
      return { ok: false as const, reason: `status_${c.review.status}` };
    return { ok: true as const, repoId: c.repo.id };
  });
  if (!loaded.ok) {
    log.info({ reviewId, reason: loaded.reason }, 'review-start skipped');
    return { status: 'skipped', reason: loaded.reason };
  }
  const repoId = loaded.repoId;

  // 2. queued → running (conditional, so a cancel between steps wins).
  const started = await step.run('mark-running', () =>
    deps.store.markRunning(reviewId, deps.now()),
  );
  if (!started) {
    log.info({ reviewId, repoId }, 'review-start skipped: no longer queued');
    return { status: 'skipped', reason: 'not_queued' };
  }

  try {
    // 3. Plan: filter files and pack them into chunks. Returns paths only.
    const plan = await step.run('plan', async () => {
      try {
        const c = await requireContext(deps, reviewId);
        if (!deps.getProvider(c.review.provider).runsInWorker) {
          throw nonRetriable(
            'internal',
            `provider ${c.review.provider} does not run in review jobs`,
          );
        }
        const files = reviewableFiles(
          await deps.github.listFiles(prRef(c)),
          c.repo.settings.ignorePaths,
        );
        const p = planChunks(files);
        await deps.store.setFilesTotal(reviewId, p.filesTotal);
        return p;
      } catch (err) {
        if (err instanceof Error && err.name === 'NonRetriableError') throw err;
        throw retriable(errorCodeOf(err), errorMessageOf(err));
      }
    });
    log.info(
      {
        reviewId,
        repoId,
        chunks: plan.chunks.length,
        filesTotal: plan.filesTotal,
        tooLarge: plan.tooLarge,
      },
      'review planned',
    );

    // 4. One step per chunk, `concurrentChunkCalls` at a time. A chunk's final failure is caught here
    //    so the other chunks still run.
    const runChunk = async (index: number, paths: string[]) => {
      const attempt = ctx.attempt; // VERIFY: inngest v3 `attempt` is the attempt of the step being run.
      try {
        const c = await requireContext(deps, reviewId);
        const ref = prRef(c);
        const all = await deps.github.listFiles(ref);
        const byPath = new Map(all.map((f) => [f.path, f]));
        // Plan order (riskiest first); re-filter (defense in depth: never send secret-like / ignored
        // files) and re-truncate exactly like the plan did.
        const files = reviewableFiles(
          paths.flatMap((p) => byPath.get(p) ?? []),
          c.repo.settings.ignorePaths,
        ).map((f) => prepareFile(f));
        const [intentNotes, guidelines] = await Promise.all([
          deps.github.fileText(ref, CONTEXT_FILES.intentNotes, c.review.headSha),
          deps.github.fileText(ref, CONTEXT_FILES.guidelines, c.review.headSha),
        ]);
        const input: ReviewChunkInput = {
          repo: c.repo.fullName,
          prNumber: c.pr.number,
          headSha: c.review.headSha,
          baseRef: c.pr.baseRef,
          title: c.pr.title,
          body: c.pr.body,
          ...(intentNotes ? { intentNotes } : {}),
          ...(guidelines ? { guidelines } : {}),
          files,
          chunkIndex: index,
          chunkCount: plan.chunks.length,
        };
        const result = await deps
          .getProvider(c.review.provider)
          .reviewChunk(input, { orgId: c.repo.orgId, model: c.repo.settings.model });

        // AI output is untrusted: re-validate and keep only issues on this chunk's files.
        const sent = new Set(files.map((f) => f.path));
        const issues: ReviewIssue[] = [];
        for (const raw of result.issues) {
          const parsed = IssueSchema.safeParse(raw);
          if (parsed.success && sent.has(parsed.data.file)) issues.push(parsed.data);
        }
        await deps.store.saveChunk(reviewId, {
          chunkIndex: index,
          chunkCount: plan.chunks.length,
          paths,
          issues,
          summary: typeof result.summary === 'string' ? result.summary : '',
        });
        const score = Number.isFinite(result.risk_score)
          ? Math.min(100, Math.max(0, result.risk_score))
          : 0;
        return { files: paths.length, issues: issues.length, riskScore: score };
      } catch (err) {
        if (err instanceof Error && err.name === 'NonRetriableError') throw err;
        throw providerFailure(err, attempt);
      }
    };

    const outcomes: ChunkOutcome[] = [];
    for (let b = 0; b < plan.chunks.length; b += LIMITS.concurrentChunkCalls) {
      const batch = plan.chunks.slice(b, b + LIMITS.concurrentChunkCalls).map((paths, j) => {
        const index = b + j;
        return step
          .run(`chunk-${index}`, () => runChunk(index, paths))
          .then(
            (r): ChunkOutcome => ({ index, ok: true, ...r }),
            (err: unknown): ChunkOutcome => {
              const code = errorCodeOf(err);
              log.warn({ reviewId, repoId, chunk: index, errorCode: code }, 'chunk failed');
              return { index, ok: false, files: paths.length, code };
            },
          );
      });
      outcomes.push(...(await Promise.all(batch)));
    }

    const ok = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    // 6. Every chunk failed → failed with the most specific code, no finalize.
    if (outcomes.length > 0 && ok.length === 0) {
      const code = mostSpecific(failed.map((f) => f.code));
      await step.run('fail', () =>
        deps.store.fail(
          reviewId,
          code,
          `All ${outcomes.length} chunks failed (${code}).`,
          deps.now(),
        ),
      );
      log.warn({ reviewId, repoId, errorCode: code }, 'review failed: all chunks failed');
      return { status: 'failed', errorCode: code };
    }

    const notes: string[] = [];
    const warning = planWarning(plan);
    if (warning) notes.push(warning);
    if (failed.length > 0) {
      const failedPaths = failed.flatMap((f) => plan.chunks[f.index] ?? []);
      const codes = [...new Set(failed.map((f) => f.code))].join(', ');
      notes.push(
        `Partial review: ${failedPaths.length} of ${plan.filesTotal} files could not be reviewed (${codes}): ${listPaths(failedPaths)}.`,
      );
    }

    await step.run('finish-chunks', () =>
      deps.store.finishChunks(reviewId, {
        filesDone: ok.reduce((n, o) => n + o.files, 0),
        aiRiskScore: ok.length > 0 ? Math.max(...ok.map((o) => o.riskScore)) : null,
        errorCode: plan.tooLarge ? 'too_large' : null,
        errorMessage: notes.length > 0 ? notes.join(' ') : null,
      }),
    );

    // 7. Hand over to review-finalize (ids only).
    await step.sendEvent('finalize', { name: 'review/finalize', data: { reviewId } });
    log.info(
      { reviewId, repoId, chunks: outcomes.length, failedChunks: failed.length },
      'review chunks done',
    );
    return { status: 'finalizing', chunks: outcomes.length, failedChunks: failed.length };
  } catch (err) {
    const code = errorCodeOf(err);
    await step.run('fail-unexpected', () =>
      deps.store.fail(reviewId, code, errorMessageOf(err), deps.now()),
    );
    log.error({ reviewId, repoId, errorCode: code }, 'review-start failed');
    return { status: 'failed', errorCode: code };
  }
}

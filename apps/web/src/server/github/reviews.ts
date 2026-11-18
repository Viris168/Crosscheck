import 'server-only';
import { prisma } from '@app/db';
import { JOB_PROVIDERS, type ProviderId, type ReviewStatus } from '@app/shared';
import { inngest } from '@/server/jobs';
import { logger } from '@/server/logger';

/** Providers that run inside our Inngest functions (`runsInWorker`). */
export function runsInWorker(provider: ProviderId): boolean {
  return (JOB_PROVIDERS as readonly ProviderId[]).includes(provider);
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'P2002';
}

export interface RequestReviewInput {
  pullRequestId: string;
  headSha: string;
  provider: ProviderId;
  orgId: string;
  repoId: string;
}

export type RequestReviewResult =
  | { created: true; reviewId: string; status: ReviewStatus }
  | { created: false; reason: 'duplicate' };

/**
 * Creates one Review for `[pullRequestId, headSha, provider]` (never two).
 * - job providers → `queued` + `review/requested` event
 * - action providers → `waiting_action`, no event (the user's Action posts to ingest)
 *
 * If the event can't be sent the row is removed again and the error rethrown, so a GitHub
 * redelivery can retry cleanly instead of leaving a `queued` review nobody will pick up.
 */
export async function requestReview(input: RequestReviewInput): Promise<RequestReviewResult> {
  const worker = runsInWorker(input.provider);
  const status: ReviewStatus = worker ? 'queued' : 'waiting_action';

  let reviewId: string;
  try {
    const review = await prisma.review.create({
      data: {
        pullRequestId: input.pullRequestId,
        headSha: input.headSha,
        provider: input.provider,
        status,
      },
      select: { id: true },
    });
    reviewId = review.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.debug({ repoId: input.repoId, headSha: input.headSha }, 'review already exists');
      return { created: false, reason: 'duplicate' };
    }
    throw err;
  }

  if (worker) {
    try {
      // Ids only — never code, patches or tokens.
      await inngest.send({ name: 'review/requested', data: { reviewId, orgId: input.orgId } });
    } catch (err) {
      await prisma.review.delete({ where: { id: reviewId } }).catch(() => undefined);
      throw err;
    }
  }

  logger.info(
    { reviewId, repoId: input.repoId, provider: input.provider, status },
    'review requested',
  );
  return { created: true, reviewId, status };
}

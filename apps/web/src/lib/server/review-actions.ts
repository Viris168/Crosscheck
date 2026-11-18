import 'server-only';
import { Prisma, prisma, type Review } from '@app/db';
import { HttpError, isActionProvider, type ProviderId, type ReviewStatus } from '@app/shared';
import { logger } from '@/server/logger';
import { inngest } from '@/server/jobs';

/** States in which a review is still being worked on; it can't be restarted until it finishes. */
export const IN_PROGRESS: readonly ReviewStatus[] = ['queued', 'running', 'waiting_action'];

/** Action providers wait for the user's GitHub Action; job providers are queued for Inngest. */
export function initialStatus(provider: ProviderId): ReviewStatus {
  return isActionProvider(provider) ? 'waiting_action' : 'queued';
}

const RESET_FIELDS = {
  errorCode: null,
  errorMessage: null,
  filesDone: 0,
  riskScore: null,
  riskLevel: null,
  riskFactors: Prisma.DbNull,
  summary: null,
  githubReviewId: null,
  startedAt: null,
  finishedAt: null,
} satisfies Prisma.ReviewUpdateManyMutationInput;

/**
 * Puts an existing, finished review back to its initial state (and drops its old issues).
 * Atomic: 409 if another request already restarted it.
 */
async function resetReview(review: Pick<Review, 'id' | 'provider'>): Promise<ReviewStatus> {
  const status = initialStatus(review.provider);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.review.updateMany({
      where: { id: review.id, status: { notIn: [...IN_PROGRESS] } },
      data: { ...RESET_FIELDS, status },
    });
    if (count === 0) throw new HttpError('conflict', 'This review is already in progress');
    await tx.issue.deleteMany({ where: { reviewId: review.id } });
  });
  return status;
}

/** Sends `review/requested` for job providers. If the send fails the review is marked failed. */
async function enqueue(reviewId: string, orgId: string, provider: ProviderId): Promise<void> {
  if (isActionProvider(provider)) return; // the user's GitHub Action posts the result to /api/ingest
  try {
    await inngest.send({ name: 'review/requested', data: { reviewId, orgId } });
  } catch (err) {
    logger.error({ reviewId, err: (err as Error).message }, 'failed to enqueue review');
    await prisma.review.update({
      where: { id: reviewId },
      data: { status: 'failed', errorCode: 'internal', errorMessage: 'Could not start the review' },
    });
    throw new HttpError('internal', 'Could not start the review');
  }
}

/** POST /api/reviews/:id/retry — only failed reviews can be retried. */
export async function retryReview(
  review: Review,
  orgId: string,
): Promise<{ reviewId: string; status: ReviewStatus }> {
  if (review.status !== 'failed') {
    throw new HttpError('conflict', 'Only failed reviews can be retried');
  }
  const status = await resetReview(review);
  await enqueue(review.id, orgId, review.provider);
  logger.info({ reviewId: review.id, provider: review.provider }, 'review retried');
  return { reviewId: review.id, status };
}

/**
 * POST /api/repos/:repoId/pulls/:number/rerun — reviews the PR's current head with `provider`.
 * One review per [pullRequestId, headSha, provider]: an existing finished one is reset and reused.
 */
export async function rerunReview(args: {
  pullRequestId: string;
  headSha: string;
  orgId: string;
  provider: ProviderId;
}): Promise<{ reviewId: string; status: ReviewStatus }> {
  const { pullRequestId, headSha, orgId, provider } = args;
  const key = { pullRequestId, headSha, provider };
  const existing = await prisma.review.findUnique({
    where: { pullRequestId_headSha_provider: key },
  });

  let reviewId: string;
  let status: ReviewStatus;
  if (existing) {
    status = await resetReview(existing);
    reviewId = existing.id;
  } else {
    status = initialStatus(provider);
    try {
      reviewId = (await prisma.review.create({ data: { ...key, status }, select: { id: true } }))
        .id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError('conflict', 'A review for this commit is already in progress');
      }
      throw err;
    }
  }
  await enqueue(reviewId, orgId, provider);
  logger.info({ reviewId, provider }, 'review re-run requested');
  return { reviewId, status };
}

import { RetryReviewResponse, ReviewParams } from '@app/shared';
import { requireReviewAccess } from '@/lib/server/access';
import { json, route } from '@/lib/server/http';
import { retryReview } from '@/lib/server/review-actions';
import { requireSession } from '@/server/auth';

/** POST /api/reviews/:id/retry — restarts a failed review with the same provider and commit. */
export const POST = route<{ id: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { id } = ReviewParams.parse(params);
  const review = await requireReviewAccess(session.user.id, id);
  const result = await retryReview(review, review.pullRequest.repo.orgId);
  return json(RetryReviewResponse, result, { status: 202 });
});

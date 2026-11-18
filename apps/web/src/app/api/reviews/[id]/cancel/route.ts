import { CancelReviewResponse, ReviewParams } from '@app/shared';
import { requireReviewAccess } from '@/lib/server/access';
import { json, route } from '@/lib/server/http';
import { cancelReview } from '@/lib/server/review-actions';
import { requireSession } from '@/server/auth';

/** POST /api/reviews/:id/cancel — stops a review that hasn't started running yet. */
export const POST = route<{ id: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { id } = ReviewParams.parse(params);
  const review = await requireReviewAccess(session.user.id, id);
  const result = await cancelReview(review);
  return json(CancelReviewResponse, result);
});

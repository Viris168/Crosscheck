import { prisma } from '@app/db';
import { ReviewDetailSchema, ReviewParams } from '@app/shared';
import { requireReviewAccess } from '@/lib/server/access';
import { json, route } from '@/lib/server/http';
import { toReviewDetail } from '@/lib/server/serialize';
import { requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** GET /api/reviews/:id — one review (polled by the PR page while it is in progress). */
export const GET = route<{ id: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { id } = ReviewParams.parse(params);
  const review = await requireReviewAccess(session.user.id, id);
  const issues = await prisma.issue.findMany({
    where: { reviewId: id },
    orderBy: [{ file: 'asc' }, { line: 'asc' }],
  });
  return json(
    ReviewDetailSchema,
    toReviewDetail({ ...review, issues }, review.pullRequest.headSha),
  );
});

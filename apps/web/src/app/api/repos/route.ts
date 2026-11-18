import { prisma } from '@app/db';
import { json, route } from '@/lib/server/http';
import { resolveCurrentOrgId } from '@/lib/server/org';
import { toLatestReviewSummary } from '@/lib/server/serialize';
import { ListReposWithLastReviewResponse } from '@/lib/pending-contracts';
import { requireOrgMember, requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** GET /api/repos — repos of the current (active) organization. */
export const GET = route(async (req) => {
  const session = await requireSession(req);
  const orgId = await resolveCurrentOrgId(session);
  if (!orgId) return json(ListReposWithLastReviewResponse, []);
  await requireOrgMember(session.user.id, orgId);

  const repos = await prisma.repo.findMany({
    where: { orgId },
    orderBy: { fullName: 'asc' },
    include: {
      pullRequests: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        where: { reviews: { some: {} } },
        select: {
          headSha: true,
          reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });

  return json(
    ListReposWithLastReviewResponse,
    repos.map((r) => {
      const pull = r.pullRequests[0];
      return {
        id: r.id,
        orgId: r.orgId,
        fullName: r.fullName,
        provider: r.provider,
        active: r.active,
        hasIngestToken: r.ingestTokenHash != null,
        lastReview: pull ? toLatestReviewSummary(pull.reviews[0], pull.headSha) : null,
      };
    }),
  );
});

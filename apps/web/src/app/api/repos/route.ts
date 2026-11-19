import { prisma } from '@app/db';
import { ListReposResponse } from '@app/shared';
import { json, route } from '@/lib/server/http';
import { visibleRepoIds } from '@/lib/server/access';
import { resolveCurrentOrgId } from '@/lib/server/org';
import { toLatestReviewSummary } from '@/lib/server/serialize';
import { requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** GET /api/repos — repos of the current (active) organization the user can see on GitHub. */
export const GET = route(async (req) => {
  const session = await requireSession(req);
  const orgId = await resolveCurrentOrgId(session);
  if (!orgId) return json(ListReposResponse, []);
  const ids = await visibleRepoIds(session.user.id, orgId);
  if (ids.length === 0) return json(ListReposResponse, []);

  const repos = await prisma.repo.findMany({
    where: { orgId, id: { in: ids } },
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
    ListReposResponse,
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

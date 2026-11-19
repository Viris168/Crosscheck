import { OrgParams, OverviewQuery, OverviewResponse } from '@app/shared';
import { json, queryOf, route } from '@/lib/server/http';
import { visibleRepoIds } from '@/lib/server/access';
import { buildOverview } from '@/lib/server/overview';
import { requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** GET /api/orgs/:orgId/overview?range=30d|90d — counts only the repos the user can see. */
export const GET = route<{ orgId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { orgId } = OrgParams.parse(params);
  const { range } = OverviewQuery.parse(queryOf(req));
  const repoIds = await visibleRepoIds(session.user.id, orgId);
  return json(OverviewResponse, await buildOverview(orgId, repoIds, range));
});

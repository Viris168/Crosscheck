import { OrgParams, OverviewQuery, OverviewResponse } from '@app/shared';
import { json, queryOf, route } from '@/lib/server/http';
import { buildOverview } from '@/lib/server/overview';
import { requireOrgMember, requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** GET /api/orgs/:orgId/overview?range=30d|90d */
export const GET = route<{ orgId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { orgId } = OrgParams.parse(params);
  const { range } = OverviewQuery.parse(queryOf(req));
  await requireOrgMember(session.user.id, orgId);
  return json(OverviewResponse, await buildOverview(orgId, range));
});

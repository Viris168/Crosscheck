import { ListMembersResponse, OrgParams } from '@app/shared';
import { json, route } from '@/lib/server/http';
import { requireOrgMember, requireSession } from '@/server/auth';
import { listMembers } from './members';

export const dynamic = 'force-dynamic';

/** GET /api/orgs/:orgId/members — any member of the org. */
export const GET = route<{ orgId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { orgId } = OrgParams.parse(params);
  await requireOrgMember(session.user.id, orgId);
  return json(ListMembersResponse, await listMembers(orgId));
});

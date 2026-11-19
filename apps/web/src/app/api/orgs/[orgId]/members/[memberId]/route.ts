import { MemberParams, UpdateMemberBody, UpdateMemberResponse } from '@app/shared';
import { json, readJson, route } from '@/lib/server/http';
import { requireOrgMember, requireSession } from '@/server/auth';
import { logger } from '@/server/logger';
import { updateMemberRole } from '../members';

export const dynamic = 'force-dynamic';

/** PATCH /api/orgs/:orgId/members/:memberId — owner only. The org always keeps one owner (409). */
export const PATCH = route<{ orgId: string; memberId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { orgId, memberId } = MemberParams.parse(params);
  await requireOrgMember(session.user.id, orgId, ['owner']);
  const { role } = UpdateMemberBody.parse(await readJson(req));
  const member = await updateMemberRole(orgId, memberId, role);
  logger.info({ orgId, memberId, role, by: session.user.id }, 'member role changed');
  return json(UpdateMemberResponse, { member });
});

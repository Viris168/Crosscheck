import 'server-only';
import { prisma } from '@app/db';
import type { AuthSession } from '@/server/auth';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/** Orgs the user belongs to, oldest membership first. */
export async function listUserOrgs(userId: string): Promise<OrgSummary[]> {
  const members = await prisma.member.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
  });
  return members.map((m) => ({ ...m.organization, role: m.role }));
}

/**
 * The org the dashboard shows: the session's active organization if the user is (still) a member,
 * otherwise their first org. null when the user has no org yet.
 */
export async function resolveCurrentOrgId(session: AuthSession): Promise<string | null> {
  const orgs = await listUserOrgs(session.user.id);
  const active = session.session.activeOrganizationId;
  if (active && orgs.some((o) => o.id === active)) return active;
  return orgs[0]?.id ?? null;
}

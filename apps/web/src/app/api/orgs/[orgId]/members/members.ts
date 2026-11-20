import 'server-only';
import { Prisma, prisma } from '@app/db';
import { HttpError, type MemberRole, type OrgMember } from '@app/shared';

/** Highest first. */
const ROLE_RANK: readonly MemberRole[] = ['owner', 'admin', 'member'];

/**
 * Better Auth stores several roles comma-separated ("admin,member"). The Members page shows one role:
 * the highest. Unknown values fall back to `member`.
 */
export function primaryRole(stored: string): MemberRole {
  const roles = stored.split(',').map((r) => r.trim());
  return ROLE_RANK.find((r) => roles.includes(r)) ?? 'member';
}

export function isOwnerRole(stored: string): boolean {
  return primaryRole(stored) === 'owner';
}

const memberSelect = {
  id: true,
  userId: true,
  role: true,
  user: { select: { login: true, name: true, avatarUrl: true, image: true } },
} satisfies Prisma.MemberSelect;

type MemberRow = Prisma.MemberGetPayload<{ select: typeof memberSelect }>;

function toOrgMember(m: MemberRow): OrgMember {
  return {
    id: m.id,
    userId: m.userId,
    login: m.user.login,
    name: m.user.name,
    avatarUrl: m.user.avatarUrl ?? m.user.image,
    role: primaryRole(m.role),
  };
}

const ROLE_ORDER: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2 };

/** Members of `orgId` (owners first, then admins, then members; by login), plus the permission flag. */
export async function listMembers(
  orgId: string,
): Promise<{ members: OrgMember[]; needsMemberPermission: boolean }> {
  const [rows, flagged] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId: orgId },
      select: memberSelect,
      orderBy: { createdAt: 'asc' },
    }),
    prisma.installation.count({ where: { orgId, needsMemberPermission: true } }),
  ]);
  const members = rows
    .map(toOrgMember)
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        (a.login ?? a.name).localeCompare(b.login ?? b.name),
    );
  return { members, needsMemberPermission: flagged > 0 };
}

/**
 * Sets a member's role. 404 unless the member belongs to `orgId`; 409 if the change would leave the
 * org without an owner. Runs serializable so two owners demoting each other at once can't both win.
 */
export async function updateMemberRole(
  orgId: string,
  memberId: string,
  role: MemberRole,
): Promise<OrgMember> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const target = await tx.member.findUnique({
          where: { id: memberId },
          select: { organizationId: true, role: true },
        });
        if (!target || target.organizationId !== orgId) {
          throw new HttpError('not_found', 'Member not found');
        }
        if (isOwnerRole(target.role) && role !== 'owner') {
          const owners = await tx.member.findMany({
            where: { organizationId: orgId },
            select: { role: true },
          });
          if (owners.filter((o) => isOwnerRole(o.role)).length <= 1) {
            throw new HttpError('conflict', 'The organization must keep at least one owner');
          }
        }
        const updated = await tx.member.update({
          where: { id: memberId },
          data: { role },
          select: memberSelect,
        });
        return toOrgMember(updated);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    // P2034: serialization failure (a concurrent role change won). Ask the client to retry.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new HttpError('conflict', 'Roles changed at the same time. Try again.');
    }
    throw err;
  }
}

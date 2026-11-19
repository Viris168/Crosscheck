import {
  ApiErrorSchema,
  HttpError,
  ListMembersResponse,
  UpdateMemberResponse,
  type MemberRole,
} from '@app/shared';
import type * as DbModule from '@app/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- in-memory db

interface Row {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}
interface UserRow {
  id: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  image: string | null;
}

const state = vi.hoisted(() => ({
  members: [] as Row[],
  users: new Map<string, UserRow>(),
  flaggedInstallations: new Map<string, number>(),
  currentUser: null as string | null,
}));

function withUser(m: Row) {
  const u = state.users.get(m.userId)!;
  return {
    id: m.id,
    userId: m.userId,
    role: m.role,
    organizationId: m.organizationId,
    user: { login: u.login, name: u.name, avatarUrl: u.avatarUrl, image: u.image },
  };
}

const db = vi.hoisted(() => {
  const member = {
    findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
      state.members.filter((m) => m.organizationId === where.organizationId).map(withUser),
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const m = state.members.find((x) => x.id === where.id);
      return m ? withUser(m) : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { role: string } }) => {
      const m = state.members.find((x) => x.id === where.id)!;
      m.role = data.role;
      return withUser(m);
    }),
  };
  return {
    member,
    installation: {
      count: vi.fn(async ({ where }: { where: { orgId: string } }) =>
        state.flaggedInstallations.get(where.orgId) ?? 0,
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ member })),
  };
});

vi.mock('@app/db', async () => {
  const { Prisma } = await vi.importActual<typeof DbModule>('@app/db');
  return { prisma: db, Prisma };
});

vi.mock('@/server/auth', () => ({
  requireSession: vi.fn(async () => {
    if (!state.currentUser) throw new HttpError('unauthorized', 'Sign in required');
    return { user: { id: state.currentUser }, session: { activeOrganizationId: null } };
  }),
  requireOrgMember: vi.fn(async (userId: string, orgId: string, roles?: MemberRole[]) => {
    const m = state.members.find((x) => x.userId === userId && x.organizationId === orgId);
    if (!m) throw new HttpError('forbidden', 'Not a member of this organization');
    const have = m.role.split(',').map((r) => r.trim());
    if (roles && !roles.some((r) => have.includes(r))) {
      throw new HttpError('forbidden', 'Insufficient role');
    }
    return { id: m.id, role: m.role };
  }),
}));

const { GET: listMembers } = await import('./route');
const { PATCH: patchMember } = await import('./[memberId]/route');

// ---------------------------------------------------------------- helpers

const T0 = new Date('2026-11-18T12:00:00Z');

function addUser(id: string, login: string | null, extra: Partial<UserRow> = {}) {
  state.users.set(id, { id, name: `User ${id}`, login, avatarUrl: null, image: null, ...extra });
}
function addMember(id: string, organizationId: string, userId: string, role: string) {
  state.members.push({ id, organizationId, userId, role, createdAt: T0 });
}
const roleOf = (id: string) => state.members.find((m) => m.id === id)?.role;

function asUser(userId: string | null) {
  state.currentUser = userId;
}

const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

function get(orgId: string) {
  return listMembers(new Request(`http://localhost/api/orgs/${orgId}/members`), ctx({ orgId }));
}

function patch(orgId: string, memberId: string, body: unknown) {
  return patchMember(
    new Request(`http://localhost/api/orgs/${orgId}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx({ orgId, memberId }),
  );
}

async function errorCode(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.members = [];
  state.users.clear();
  state.flaggedInstallations.clear();
  state.currentUser = null;

  addUser('u-owner', 'octo-owner', { avatarUrl: 'https://avatars.example/owner' });
  addUser('u-admin', 'octo-admin', { image: 'https://avatars.example/admin-image' });
  addUser('u-member', 'octo-member');
  addUser('u-nologin', null);
  addUser('u-other', 'other-org');

  addMember('m-owner', 'org1', 'u-owner', 'owner');
  addMember('m-admin', 'org1', 'u-admin', 'admin');
  addMember('m-member', 'org1', 'u-member', 'member');
  addMember('m-nologin', 'org1', 'u-nologin', 'member');
  addMember('m-other', 'org2', 'u-other', 'owner');
});

// ---------------------------------------------------------------- GET

describe('GET /api/orgs/:orgId/members', () => {
  it('401 without a session', async () => {
    const res = await get('org1');
    expect(res.status).toBe(401);
  });

  it.each(['u-owner', 'u-admin', 'u-member'])('any member can list (%s)', async (userId) => {
    asUser(userId);
    const res = await get('org1');
    expect(res.status).toBe(200);
    const body = ListMembersResponse.parse(await res.json());
    expect(body.needsMemberPermission).toBe(false);
    expect(body.members.map((m) => m.id)).toEqual(['m-owner', 'm-admin', 'm-member', 'm-nologin']);
  });

  it('returns login, name, avatar (falling back to image) and role from User', async () => {
    asUser('u-member');
    const body = ListMembersResponse.parse(await (await get('org1')).json());
    const byId = Object.fromEntries(body.members.map((m) => [m.id, m]));
    expect(byId['m-owner']).toEqual({
      id: 'm-owner',
      userId: 'u-owner',
      login: 'octo-owner',
      name: 'User u-owner',
      avatarUrl: 'https://avatars.example/owner',
      role: 'owner',
    });
    expect(byId['m-admin']!.avatarUrl).toBe('https://avatars.example/admin-image');
    expect(byId['m-nologin']!.login).toBeNull();
    expect(byId['m-nologin']!.avatarUrl).toBeNull();
  });

  it('never leaks members of another org', async () => {
    asUser('u-owner');
    const body = ListMembersResponse.parse(await (await get('org1')).json());
    expect(body.members.some((m) => m.id === 'm-other')).toBe(false);
  });

  it('shows the highest of comma-separated Better Auth roles', async () => {
    state.members.find((m) => m.id === 'm-member')!.role = 'member,admin';
    asUser('u-owner');
    const body = ListMembersResponse.parse(await (await get('org1')).json());
    expect(body.members.find((m) => m.id === 'm-member')!.role).toBe('admin');
  });

  it('needsMemberPermission is true when any installation of the org is flagged', async () => {
    state.flaggedInstallations.set('org1', 1);
    asUser('u-member');
    const body = ListMembersResponse.parse(await (await get('org1')).json());
    expect(body.needsMemberPermission).toBe(true);
    expect(db.installation.count).toHaveBeenCalledWith({
      where: { orgId: 'org1', needsMemberPermission: true },
    });
  });

  it('403 for a non-member', async () => {
    asUser('u-other');
    const res = await get('org1');
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
    expect(db.member.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- PATCH

describe('PATCH /api/orgs/:orgId/members/:memberId', () => {
  it('401 without a session', async () => {
    const res = await patch('org1', 'm-member', { role: 'admin' });
    expect(res.status).toBe(401);
  });

  it.each(['u-admin', 'u-member'])('403 for a non-owner (%s)', async (userId) => {
    asUser(userId);
    const res = await patch('org1', 'm-member', { role: 'admin' });
    expect(res.status).toBe(403);
    expect(roleOf('m-member')).toBe('member');
    expect(db.member.update).not.toHaveBeenCalled();
  });

  it('403 for an owner of another org', async () => {
    asUser('u-other');
    const res = await patch('org1', 'm-member', { role: 'owner' });
    expect(res.status).toBe(403);
    expect(roleOf('m-member')).toBe('member');
  });

  it('owner can promote a member to admin', async () => {
    asUser('u-owner');
    const res = await patch('org1', 'm-member', { role: 'admin' });
    expect(res.status).toBe(200);
    const body = UpdateMemberResponse.parse(await res.json());
    expect(body.member).toMatchObject({ id: 'm-member', login: 'octo-member', role: 'admin' });
    expect(roleOf('m-member')).toBe('admin');
  });

  it('owner can demote an admin to member', async () => {
    asUser('u-owner');
    const res = await patch('org1', 'm-admin', { role: 'member' });
    expect(res.status).toBe(200);
    expect(roleOf('m-admin')).toBe('member');
  });

  it('owner can transfer ownership: promote someone, then demote themselves', async () => {
    asUser('u-owner');
    expect((await patch('org1', 'm-admin', { role: 'owner' })).status).toBe(200);
    expect((await patch('org1', 'm-owner', { role: 'member' })).status).toBe(200);
    expect(roleOf('m-admin')).toBe('owner');
    expect(roleOf('m-owner')).toBe('member');
  });

  it('runs inside a serializable transaction', async () => {
    asUser('u-owner');
    await patch('org1', 'm-member', { role: 'admin' });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('409 when demoting the last owner (themselves)', async () => {
    asUser('u-owner');
    const res = await patch('org1', 'm-owner', { role: 'admin' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(roleOf('m-owner')).toBe('owner');
    expect(db.member.update).not.toHaveBeenCalled();
  });

  it('counts owners stored comma-separated', async () => {
    state.members.find((m) => m.id === 'm-admin')!.role = 'admin,owner';
    asUser('u-owner');
    const res = await patch('org1', 'm-owner', { role: 'member' });
    expect(res.status).toBe(200);
  });

  it('setting an owner to owner again is allowed', async () => {
    asUser('u-owner');
    const res = await patch('org1', 'm-owner', { role: 'owner' });
    expect(res.status).toBe(200);
  });

  it('404 for a member of another org', async () => {
    asUser('u-owner');
    const res = await patch('org1', 'm-other', { role: 'member' });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(roleOf('m-other')).toBe('owner');
  });

  it('404 for an unknown member id', async () => {
    asUser('u-owner');
    const res = await patch('org1', 'nope', { role: 'member' });
    expect(res.status).toBe(404);
  });

  it.each([{ role: 'superuser' }, {}, 'not json'])('400 for a bad body (%j)', async (body) => {
    asUser('u-owner');
    const res = await patch('org1', 'm-member', body);
    expect(res.status).toBe(400);
    expect(roleOf('m-member')).toBe('member');
  });

  it('409 when a concurrent role change wins the serializable race', async () => {
    const { Prisma } = await vi.importActual<typeof DbModule>('@app/db');
    db.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    asUser('u-owner');
    const res = await patch('org1', 'm-member', { role: 'admin' });
    expect(res.status).toBe(409);
  });
});

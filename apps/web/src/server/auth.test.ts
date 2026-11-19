import { HttpError } from '@app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
vi.mock('@app/db', () => ({ prisma: { member: { findUnique } } }));

const getSession = vi.fn();
const betterAuth = vi.fn((_options: unknown) => ({ api: { getSession }, handler: vi.fn() }));
vi.mock('better-auth', () => ({ betterAuth }));

const send = vi.fn();
vi.mock('@/server/jobs', () => ({ inngest: { send } }));

const warn = vi.fn();
vi.mock('./logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const { createAuth, DISABLED_ORG_PATHS, onSessionCreated, requireOrgMember, requireSession } =
  await import('./auth');

beforeEach(() => {
  findUnique.mockReset();
  getSession.mockReset();
  send.mockReset();
  warn.mockReset();
});

describe('requireSession', () => {
  it('returns the session', async () => {
    const session = { user: { id: 'u1' }, session: { id: 's1' } };
    getSession.mockResolvedValue(session);
    const headers = new Headers({ cookie: 'x=1' });
    await expect(requireSession({ headers })).resolves.toBe(session);
    expect(getSession).toHaveBeenCalledWith({ headers });
  });

  it('throws 401 without a session', async () => {
    getSession.mockResolvedValue(null);
    const err = await requireSession(new Request('http://x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });
});

describe('requireOrgMember', () => {
  it('returns the membership', async () => {
    findUnique.mockResolvedValue({ id: 'm1', role: 'admin' });
    await expect(requireOrgMember('u1', 'o1')).resolves.toEqual({ id: 'm1', role: 'admin' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: 'o1', userId: 'u1' } },
      select: { id: true, role: true },
    });
  });

  it('throws 403 for non-members', async () => {
    findUnique.mockResolvedValue(null);
    const err = await requireOrgMember('u1', 'o1').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
  });

  it('checks roles', async () => {
    findUnique.mockResolvedValue({ id: 'm1', role: 'member' });
    await expect(requireOrgMember('u1', 'o1', ['owner', 'admin'])).rejects.toMatchObject({
      status: 403,
    });
    findUnique.mockResolvedValue({ id: 'm1', role: 'member,admin' });
    await expect(requireOrgMember('u1', 'o1', ['admin'])).resolves.toMatchObject({ id: 'm1' });
  });
});

describe('onSessionCreated (session.create.after)', () => {
  it('sends user/signed-in with the userId only', async () => {
    send.mockResolvedValue({ ids: ['e1'] });
    await onSessionCreated({ userId: 'u1', token: 'secret-session-token' } as { userId: string });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ name: 'user/signed-in', data: { userId: 'u1' } });
  });

  it('never throws when the send fails, and logs only the userId', async () => {
    send.mockRejectedValue(new Error('inngest down'));
    await expect(onSessionCreated({ userId: 'u1' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields.userId).toBe('u1');
    expect(JSON.stringify(fields)).not.toContain('token');
  });
});

describe('createAuth options', () => {
  type Opts = {
    disabledPaths: string[];
    account: { encryptOAuthTokens: boolean };
    databaseHooks: { session: { create: { after: (s: { userId: string }) => Promise<void> } } };
  };
  const opts = () => {
    betterAuth.mockClear();
    createAuth();
    return betterAuth.mock.calls[0]![0] as Opts;
  };

  it('disables org mutations but keeps set-active and reads', () => {
    const { disabledPaths } = opts();
    for (const p of ['create', 'invite-member', 'remove-member', 'update-member-role']) {
      expect(disabledPaths).toContain(`/organization/${p}`);
    }
    expect(disabledPaths).not.toContain('/organization/set-active');
    expect(disabledPaths).not.toContain('/organization/list');
    expect(disabledPaths).not.toContain('/organization/get-full-organization');
    expect(disabledPaths).toEqual([...DISABLED_ORG_PATHS]);
  });

  it('encrypts OAuth tokens', () => {
    expect(opts().account.encryptOAuthTokens).toBe(true);
  });

  it('wires the session hook', async () => {
    send.mockResolvedValue({});
    await opts().databaseHooks.session.create.after({ userId: 'u2' });
    expect(send).toHaveBeenCalledWith({ name: 'user/signed-in', data: { userId: 'u2' } });
  });
});

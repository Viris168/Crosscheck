import { HttpError } from '@app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
vi.mock('@app/db', () => ({ prisma: { member: { findUnique } } }));

const getSession = vi.fn();
vi.mock('better-auth', () => ({ betterAuth: () => ({ api: { getSession }, handler: vi.fn() }) }));

const { requireOrgMember, requireSession } = await import('./auth');

beforeEach(() => {
  findUnique.mockReset();
  getSession.mockReset();
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

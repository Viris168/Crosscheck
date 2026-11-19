import { ApiErrorSchema, HttpError, SyncOrgsResponse } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  currentUser: null as string | null,
  redisDown: false,
  expireFails: false,
  counters: new Map<string, number>(),
  expires: new Map<string, number>(),
}));

const sync = vi.hoisted(() => vi.fn());

vi.mock('@/server/auth', () => ({
  requireSession: vi.fn(async () => {
    if (!state.currentUser) throw new HttpError('unauthorized', 'Sign in required');
    return { user: { id: state.currentUser }, session: { activeOrganizationId: null } };
  }),
}));

vi.mock('@/server/github', () => ({ syncUserMemberships: sync }));

vi.mock('@/server/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    incr: vi.fn(async (key: string) => {
      if (state.redisDown) throw new Error('ECONNREFUSED');
      const n = (state.counters.get(key) ?? 0) + 1;
      state.counters.set(key, n);
      return n;
    }),
    expire: vi.fn(async (key: string, ttl: number) => {
      if (state.expireFails) throw new Error('ECONNRESET');
      state.expires.set(key, ttl);
      return 1;
    }),
  }),
}));

const { POST } = await import('./route');

const call = () =>
  POST(new Request('http://localhost/api/me/sync-orgs', { method: 'POST' }), {
    params: Promise.resolve({}),
  });

const KEY = 'rl:sync-orgs:user_1:';

beforeEach(() => {
  // Start of a 60s window, so a burst of calls stays in one window.
  vi.useFakeTimers({ now: new Date('2026-11-19T12:00:00Z'), toFake: ['Date'] });
  state.currentUser = 'user_1';
  state.redisDown = false;
  state.expireFails = false;
  state.counters.clear();
  state.expires.clear();
  sync.mockReset();
  sync.mockResolvedValue({ joined: ['org_1'], left: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

const counterKey = () => [...state.counters.keys()].find((k) => k.startsWith(KEY));

describe('POST /api/me/sync-orgs', () => {
  it('returns 401 without a session and does not sync', async () => {
    state.currentUser = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('unauthorized');
    expect(sync).not.toHaveBeenCalled();
  });

  it("syncs the session user's memberships and returns the result", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(SyncOrgsResponse.parse(await res.json())).toEqual({ joined: ['org_1'], left: [] });
    expect(sync).toHaveBeenCalledWith('user_1');
    const key = counterKey();
    expect(key).toMatch(/^rl:sync-orgs:user_1:\d+$/);
    expect(state.counters.get(key!)).toBe(1);
    expect(state.expires.get(key!)).toBe(60);
  });

  it('returns 429 rate_limited on the 6th call in a minute', async () => {
    for (let i = 0; i < 5; i++) expect((await call()).status).toBe(200);
    const res = await call();
    expect(res.status).toBe(429);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('rate_limited');
    expect(sync).toHaveBeenCalledTimes(5);
  });

  it('allows calls again in the next window', async () => {
    for (let i = 0; i < 6; i++) await call();
    vi.setSystemTime(new Date('2026-11-19T12:01:00Z'));
    expect((await call()).status).toBe(200);
  });

  it('a failed EXPIRE does not lock the user out', async () => {
    state.expireFails = true;
    for (let i = 0; i < 6; i++) await call();
    state.expireFails = false;
    vi.setSystemTime(new Date('2026-11-19T12:01:00Z'));
    expect((await call()).status).toBe(200);
  });

  it('limits per user', async () => {
    for (let i = 0; i < 5; i++) await call();
    state.currentUser = 'user_2';
    expect((await call()).status).toBe(200);
  });

  it('still syncs when Redis is down', async () => {
    state.redisDown = true;
    const res = await call();
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith('user_1');
  });

  it('maps a sync failure to 500 without leaking the message', async () => {
    sync.mockRejectedValue(new Error('boom secret'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});

import { decrypt, HttpError } from '@app/shared';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_OAUTH_COOKIE,
  decodePending,
  encodePending,
  newPendingAuth,
  safeReturnTo,
} from '@/lib/server/oauth-state';

const KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ENCRYPTION_KEY = KEY;
process.env.PUBLIC_URL = 'http://localhost:3000';

const upsert = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
vi.mock('@app/db', () => ({ prisma: { providerCredential: { upsert }, member: { findMany } } }));

const session = vi.hoisted(() => ({ value: null as null | object }));
const requireOrgMember = vi.hoisted(() => vi.fn());
vi.mock('@/server/auth', () => ({
  auth: { api: { getSession: vi.fn(async () => session.value) } },
  requireOrgMember,
}));

const oauth = vi.hoisted(() => ({ authorizeUrl: vi.fn(), exchangeCode: vi.fn() }));
vi.mock('@app/providers', () => ({ chatgptOAuth: oauth }));

const { GET: start } = await import('./start/route');
const { GET: callback } = await import('./callback/route');

const nreq = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  session.value = { user: { id: 'u1' }, session: { activeOrganizationId: 'org1' } };
  findMany.mockResolvedValue([
    { role: 'member', organization: { id: 'org1', name: 'A', slug: 'a' } },
  ]);
  requireOrgMember.mockResolvedValue({ id: 'm', role: 'member' });
});

describe('oauth state helpers', () => {
  it('round-trips the pending state and rejects garbage', () => {
    const { pending, codeChallenge } = newPendingAuth('org1', '/x');
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodePending(encodePending(pending))).toEqual(pending);
    expect(decodePending('not-base64-json')).toBeNull();
    expect(decodePending(undefined)).toBeNull();
  });

  it.each([
    ['/repos/x/setup', '/repos/x/setup'],
    ['//evil.com', '/settings/connections'],
    ['/\\evil.com', '/settings/connections'],
    ['https://evil.com', '/settings/connections'],
    [null, '/settings/connections'],
  ])('safeReturnTo(%s) → %s', (input, out) => expect(safeReturnTo(input)).toBe(out));
});

describe('GET /api/oauth/chatgpt/start', () => {
  it('signed out → /sign-in', async () => {
    session.value = null;
    const res = await start(nreq('/api/oauth/chatgpt/start'));
    expect(res.headers.get('location')).toBe('http://localhost:3000/sign-in');
  });

  it('redirects to ChatGPT with state + PKCE and sets an httpOnly state cookie', async () => {
    oauth.authorizeUrl.mockReturnValue('https://auth.example/authorize?x=1');
    const res = await start(nreq('/api/oauth/chatgpt/start?returnTo=/repos/r1/setup'));
    expect(res.headers.get('location')).toBe('https://auth.example/authorize?x=1');
    const [state, redirectUri, opts] = oauth.authorizeUrl.mock.calls[0]!;
    expect(redirectUri).toBe('http://localhost:3000/api/oauth/chatgpt/callback');
    expect(opts.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain(`${CHATGPT_OAUTH_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain('httponly');
    const pending = decodePending(cookie.split(';')[0]!.split('=')[1]);
    expect(pending).toMatchObject({
      state,
      orgId: 'org1',
      returnTo: '/repos/r1/setup',
    });
  });

  it('an HttpError from the OAuth helper → back to the page with ?error=<code>', async () => {
    oauth.authorizeUrl.mockImplementation(() => {
      throw new HttpError('not_implemented', 'x');
    });
    const res = await start(nreq('/api/oauth/chatgpt/start'));
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/settings/connections?error=not_implemented',
    );
  });
});

describe('GET /api/oauth/chatgpt/callback', () => {
  const pending = {
    state: 's'.repeat(32),
    verifier: 'v'.repeat(43),
    orgId: 'org1',
    returnTo: '/repos/r1/setup',
  };
  const cookie = `${CHATGPT_OAUTH_COOKIE}=${encodePending(pending)}`;

  it('rejects a mismatched state and clears the cookie', async () => {
    const res = await callback(
      nreq(`/api/oauth/chatgpt/callback?code=c&state=${'x'.repeat(32)}`, cookie),
    );
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/repos/r1/setup?error=invalid_state',
    );
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a callback without the state cookie', async () => {
    const res = await callback(nreq(`/api/oauth/chatgpt/callback?code=c&state=${pending.state}`));
    expect(res.headers.get('location')).toContain('error=invalid_state');
  });

  it('rejects missing code (400 → error=bad_request)', async () => {
    const res = await callback(nreq(`/api/oauth/chatgpt/callback?state=${pending.state}`, cookie));
    expect(res.headers.get('location')).toContain('error=bad_request');
  });

  it('re-checks org membership', async () => {
    requireOrgMember.mockRejectedValue(new HttpError('forbidden', 'no'));
    const res = await callback(
      nreq(`/api/oauth/chatgpt/callback?code=c&state=${pending.state}`, cookie),
    );
    expect(res.headers.get('location')).toContain('error=forbidden');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('exchanges the code with the PKCE verifier and stores tokens encrypted', async () => {
    oauth.exchangeCode.mockResolvedValue({ accessToken: 'at-secret', refreshToken: 'rt-secret' });
    const res = await callback(
      nreq(`/api/oauth/chatgpt/callback?code=c0de&state=${pending.state}`, cookie),
    );
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/repos/r1/setup?connected=chatgpt',
    );
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      'c0de',
      'http://localhost:3000/api/oauth/chatgpt/callback',
      { codeVerifier: pending.verifier },
    );
    const arg = upsert.mock.calls[0]![0];
    expect(arg.where.orgId_userId_provider).toEqual({
      orgId: 'org1',
      userId: 'u1',
      provider: 'codex_chatgpt',
    });
    expect(JSON.stringify(arg)).not.toContain('at-secret');
    expect(JSON.stringify(arg)).not.toContain('rt-secret');
    expect(decrypt(arg.create.encryptedToken, Buffer.from(KEY, 'base64'))).toBe('at-secret');
    expect(decrypt(arg.update.encryptedRefreshToken, Buffer.from(KEY, 'base64'))).toBe('rt-secret');
  });
});

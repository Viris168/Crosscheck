import { createHash } from 'node:crypto';
import { ProviderError } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';
import { createChatgptOAuth, createPkcePair } from './chatgpt-oauth';
import { jsonResponse } from './test-fixtures';

const NOW = new Date('2026-11-18T12:00:00Z');
const env = { CHATGPT_OAUTH_CLIENT_ID: 'client_1' };

describe('chatgptOAuth', () => {
  it('builds an authorize URL with plan-usage scopes, resource and PKCE', () => {
    const { challenge } = createPkcePair();
    const oauth = createChatgptOAuth({ env });
    const url = new URL(oauth.authorizeUrl('st_1', 'https://app.test/cb', { codeChallenge: challenge, nonce: 'n1' }));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('client_1');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('state')).toBe('st_1');
    expect(q.get('nonce')).toBe('n1');
    expect(q.get('redirect_uri')).toBe('https://app.test/cb');
    expect(q.get('resource')).toBe('https://api.openai.com/v1');
    expect(q.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']),
    );
    expect(q.get('code_challenge')).toBe(challenge);
    expect(q.get('code_challenge_method')).toBe('S256');
  });

  it('createPkcePair produces an S256 challenge of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('exchangeCode posts a form and returns tokens with expiresAt', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
      }),
    );
    const oauth = createChatgptOAuth({ env: { ...env, CHATGPT_OAUTH_CLIENT_SECRET: 'sec' }, fetch: fetchMock as unknown as typeof fetch, now: () => NOW });
    const tokens = await oauth.exchangeCode('code_1', 'https://app.test/cb', { codeVerifier: 'ver' });
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAt).toEqual(new Date(NOW.getTime() + 3600_000));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://auth.openai.com/api/accounts/oauth/token');
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code_1');
    expect(form.get('code_verifier')).toBe('ver');
    expect(form.get('redirect_uri')).toBe('https://app.test/cb');
    expect(form.get('client_secret')).toBe('sec');
  });

  it('rejects a grant without the plan-usage scope', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: 'at', scope: 'openid profile email' }));
    const oauth = createChatgptOAuth({ env, fetch: fetchMock as unknown as typeof fetch });
    const err = await oauth.exchangeCode('c', 'https://app.test/cb').catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('provider_auth');
  });

  it.each([
    [400, { error: 'invalid_grant' }, 'provider_auth'],
    [401, {}, 'provider_auth'],
    [429, {}, 'rate_limited'],
    [500, {}, 'internal'],
  ] as const)('maps token endpoint HTTP %i to %s', async (status, body, code) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, body));
    const oauth = createChatgptOAuth({ env, fetch: fetchMock as unknown as typeof fetch });
    const err = await oauth.refresh('rt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe(code);
  });

  it('fails clearly without a client id', () => {
    const oauth = createChatgptOAuth({ env: {} });
    expect(() => oauth.authorizeUrl('s', 'https://app.test/cb')).toThrow(ProviderError);
  });
});

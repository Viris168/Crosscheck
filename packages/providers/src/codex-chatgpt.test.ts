import { randomBytes } from 'node:crypto';
import { ProviderError, decrypt, encrypt } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialStore, StoredCredential } from './credentials';
import { createCodexChatgptProvider } from './providers/codex-chatgpt';
import { jsonResponse, openaiResponse, sampleInput, validResultJson } from './test-fixtures';

const key = randomBytes(32);
const NOW = new Date('2026-11-18T12:00:00Z');
const env = { CHATGPT_OAUTH_CLIENT_ID: 'client_1' };
const ctx = { orgId: 'org_1', userId: 'user_1' };

function memoryStore(cred: StoredCredential | null) {
  const saves: Array<{ id: string; data: Parameters<CredentialStore['save']>[1] }> = [];
  const store: CredentialStore = {
    load: vi.fn(async () => cred),
    save: vi.fn(async (id, data) => {
      saves.push({ id, data });
    }),
  };
  return { store, saves };
}

function cred(expiresAt: Date | null, refresh: string | null = 'refresh_old'): StoredCredential {
  return {
    id: 'cred_1',
    encryptedToken: encrypt('access_old', key),
    encryptedRefreshToken: refresh ? encrypt(refresh, key) : null,
    expiresAt,
  };
}

/** Routes token endpoint vs. Responses API calls. */
function http(
  tokenStatus = 200,
  tokenBody: unknown = {
    access_token: 'access_new',
    refresh_token: 'refresh_new',
    expires_in: 3600,
  },
) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes('auth.openai.com')) return jsonResponse(tokenStatus, tokenBody);
    return jsonResponse(200, openaiResponse(JSON.stringify(validResultJson), 'gpt-5-codex'));
  });
}

function bearerOfApiCall(fetchMock: ReturnType<typeof http>): string | undefined {
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/responses'));
  const headers = new Headers(call?.[1]?.headers);
  return headers.get('authorization') ?? undefined;
}

describe('codex_chatgpt provider', () => {
  it('uses the stored token when not expired (no refresh)', async () => {
    const { store, saves } = memoryStore(cred(new Date(NOW.getTime() + 3600_000)));
    const fetchMock = http();
    const p = createCodexChatgptProvider({
      env,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      encryptionKey: key,
    });

    const res = await p.reviewChunk(sampleInput(), ctx);
    expect(res).toEqual({ ...validResultJson, model: 'gpt-5-codex' });
    expect(store.load).toHaveBeenCalledWith(ctx);
    expect(saves).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('auth.openai.com'))).toBe(false);
    expect(bearerOfApiCall(fetchMock)).toBe('Bearer access_old');
  });

  it('refreshes an expired token, re-saves it encrypted, and uses the new token', async () => {
    const { store, saves } = memoryStore(cred(new Date(NOW.getTime() - 1000)));
    const fetchMock = http();
    const p = createCodexChatgptProvider({
      env,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      encryptionKey: key,
    });

    await p.reviewChunk(sampleInput(), ctx);

    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).includes('auth.openai.com'));
    const form = new URLSearchParams(String(tokenCall?.[1]?.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh_old');
    expect(form.get('client_id')).toBe('client_1');

    expect(saves).toHaveLength(1);
    const saved = saves[0]!;
    expect(saved.id).toBe('cred_1');
    expect(saved.data.encryptedToken).not.toContain('access_new'); // stored encrypted
    expect(decrypt(saved.data.encryptedToken, key)).toBe('access_new');
    expect(decrypt(saved.data.encryptedRefreshToken!, key)).toBe('refresh_new');
    expect(saved.data.expiresAt).toEqual(new Date(NOW.getTime() + 3600_000));
    expect(bearerOfApiCall(fetchMock)).toBe('Bearer access_new');
  });

  it('refreshes a token that is about to expire', async () => {
    const { store, saves } = memoryStore(cred(new Date(NOW.getTime() + 30_000)));
    const fetchMock = http();
    const p = createCodexChatgptProvider({
      env,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      encryptionKey: key,
    });
    await p.reviewChunk(sampleInput(), ctx);
    expect(saves).toHaveLength(1);
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const c = cred(new Date(NOW.getTime() - 1000));
    const { store, saves } = memoryStore(c);
    const fetchMock = http(200, { access_token: 'access_new', expires_in: 60 });
    const p = createCodexChatgptProvider({
      env,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      encryptionKey: key,
    });
    await p.reviewChunk(sampleInput(), ctx);
    expect(saves[0]!.data.encryptedRefreshToken).toBe(c.encryptedRefreshToken);
  });

  it.each([
    ['no credential', null, http()],
    ['expired without refresh token', cred(new Date(0), null), http()],
    ['refresh rejected (invalid_grant)', cred(new Date(0)), http(400, { error: 'invalid_grant' })],
  ])('throws provider_auth: %s', async (_name, c, fetchMock) => {
    const { store, saves } = memoryStore(c);
    const p = createCodexChatgptProvider({
      env,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      encryptionKey: key,
    });
    const err = await p.reviewChunk(sampleInput(), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('provider_auth');
    expect(saves).toHaveLength(0);
  });

  it('maps a 401 from the API to provider_auth', async () => {
    const { store } = memoryStore(cred(null));
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { message: 'bad token', type: 'x', code: null } }),
    );
    const p = createCodexChatgptProvider({
      env,
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      encryptionKey: key,
    });
    const err = await p.reviewChunk(sampleInput(), ctx).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('provider_auth');
  });
});

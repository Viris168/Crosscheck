import type * as NodeCrypto from 'node:crypto';
import { ProviderError } from '@app/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createOctokit,
  fetchFileText,
  fetchPullRequest,
  fetchPullRequestFiles,
  getInstallationOctokit,
  readAppCredentials,
  resetGithubClients,
  setInstallationAuthForTesting,
  signWebhookBody,
  splitFullName,
  verifyWebhookSignature,
} from './index';

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

const API = 'https://api.github.com';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetGithubClients();
  vi.useRealTimers();
});
afterAll(() => server.close());

/** No retries/throttling so error tests are fast and deterministic. */
const octokit = () =>
  createOctokit({ auth: 'test-token', retry: { enabled: false }, throttle: { enabled: false } });

// ---------------------------------------------------------------- signature

describe('verifyWebhookSignature', () => {
  const secret = 'shh';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const valid = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(body, valid, secret)).toBe(true);
    expect(verifyWebhookSignature(body, signWebhookBody(body, secret), secret)).toBe(true);
  });

  it('accepts an upper-case hex digest', () => {
    expect(verifyWebhookSignature(body, 'sha256=' + valid.slice(7).toUpperCase(), secret)).toBe(
      true,
    );
  });

  it('rejects a wrong secret, tampered body or wrong digest', () => {
    expect(verifyWebhookSignature(body, valid, 'other')).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('{"hello":"wor1d"}'), valid, secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=' + '0'.repeat(64), secret)).toBe(false);
  });

  it('rejects a missing or malformed header without throwing', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    expect(verifyWebhookSignature(body, valid.slice(7), secret)).toBe(false); // no prefix
    expect(verifyWebhookSignature(body, 'sha1=' + valid.slice(7), secret)).toBe(false);
    expect(verifyWebhookSignature(body, valid.slice(0, -2), secret)).toBe(false); // short
    expect(verifyWebhookSignature(body, valid + 'ab', secret)).toBe(false); // long
    expect(verifyWebhookSignature(body, 'sha256=' + 'z'.repeat(64), secret)).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    expect(verifyWebhookSignature(body, valid, '')).toBe(false);
  });

  it('compares with crypto.timingSafeEqual', () => {
    timingSafeEqualSpy.mockClear();
    verifyWebhookSignature(body, valid, secret);
    verifyWebhookSignature(body, 'sha256=' + '0'.repeat(64), secret);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------- helpers

describe('splitFullName', () => {
  it('splits owner/repo', () => {
    expect(splitFullName('acme/web')).toEqual({ owner: 'acme', repo: 'web' });
  });
  it.each(['acme', 'acme/', '/web', 'a/b/c', ''])('rejects %j', (name) => {
    expect(() => splitFullName(name)).toThrow(/Invalid repository full name/);
  });
});

describe('readAppCredentials', () => {
  it('unescapes \\n in a single-line private key', () => {
    const creds = readAppCredentials({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN-----\\nabc\\n-----END-----',
    });
    expect(creds).toEqual({ appId: '123', privateKey: '-----BEGIN-----\nabc\n-----END-----' });
  });
  it('throws without leaking values when missing', () => {
    expect(() => readAppCredentials({ GITHUB_APP_ID: '1' })).toThrow(
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set',
    );
  });
});

describe('getInstallationOctokit', () => {
  it('caches per installation until shortly before the token expires', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
    const auth = vi.fn(async ({ installationId }: { installationId: number }) => ({
      token: `tok-${installationId}`,
      expiresAt: '2026-01-01T01:00:00Z',
    }));
    setInstallationAuthForTesting(auth as never);

    const [a, b] = await Promise.all([getInstallationOctokit(1), getInstallationOctokit(1)]);
    expect(a).toBe(b);
    expect(auth).toHaveBeenCalledTimes(1);

    await getInstallationOctokit(2);
    expect(auth).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-01-01T00:50:00Z')); // 10 min left → still cached
    expect(await getInstallationOctokit(1)).toBe(a);

    vi.setSystemTime(new Date('2026-01-01T00:56:00Z')); // < 5 min left → refresh
    const c = await getInstallationOctokit(1);
    expect(c).not.toBe(a);
    expect(auth).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed token request', async () => {
    const auth = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ token: 't', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    setInstallationAuthForTesting(auth);
    await expect(getInstallationOctokit(9)).rejects.toThrow('boom');
    await expect(getInstallationOctokit(9)).resolves.toBeDefined();
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it('sends the installation token on requests', async () => {
    setInstallationAuthForTesting(async () => ({
      token: 'ghs_install',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    let authHeader: string | null = null;
    server.use(
      http.get(`${API}/repos/acme/web/pulls/1`, ({ request }) => {
        authHeader = request.headers.get('authorization');
        return HttpResponse.json(prPayload());
      }),
    );
    await fetchPullRequest(await getInstallationOctokit(5), 'acme', 'web', 1);
    expect(authHeader).toBe('token ghs_install');
  });
});

// ---------------------------------------------------------------- fetch helpers

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Add thing',
    body: null,
    user: { login: 'octo' },
    state: 'open',
    merged: false,
    draft: false,
    head: { sha: 'abc', ref: 'feat' },
    base: { sha: 'def', ref: 'main' },
    additions: 3,
    deletions: 1,
    changed_files: 2,
    ...overrides,
  };
}

describe('fetchPullRequest', () => {
  it('maps the PR', async () => {
    server.use(http.get(`${API}/repos/acme/web/pulls/1`, () => HttpResponse.json(prPayload())));
    expect(await fetchPullRequest(octokit(), 'acme', 'web', 1)).toEqual({
      number: 1,
      title: 'Add thing',
      body: '',
      author: 'octo',
      state: 'open',
      merged: false,
      draft: false,
      headSha: 'abc',
      headRef: 'feat',
      baseRef: 'main',
      baseSha: 'def',
      additions: 3,
      deletions: 1,
      changedFiles: 2,
    });
  });

  it('maps API failures to ProviderError github_error', async () => {
    server.use(
      http.get(`${API}/repos/acme/web/pulls/1`, () =>
        HttpResponse.json({ message: 'Server Error' }, { status: 502 }),
      ),
    );
    const err = await fetchPullRequest(octokit(), 'acme', 'web', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'github_error' });
    expect((err as Error).message).toContain('502');
  });
});

describe('fetchPullRequestFiles', () => {
  const file = (i: number, extra: Record<string, unknown> = {}) => ({
    filename: `src/f${i}.ts`,
    status: 'modified',
    patch: `@@ -1 +1 @@\n-a${i}\n+b${i}`,
    ...extra,
  });

  it('paginates until a short page', async () => {
    const pages: number[] = [];
    server.use(
      http.get(`${API}/repos/acme/web/pulls/7/files`, ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get('page'));
        expect(url.searchParams.get('per_page')).toBe('100');
        pages.push(page);
        const count = page < 3 ? 100 : 5;
        return HttpResponse.json(
          Array.from({ length: count }, (_, i) => file((page - 1) * 100 + i)),
        );
      }),
    );
    const files = await fetchPullRequestFiles(octokit(), 'acme', 'web', 7);
    expect(pages).toEqual([1, 2, 3]);
    expect(files).toHaveLength(205);
    expect(files[204]).toEqual({
      path: 'src/f204.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-a204\n+b204',
    });
  });

  it('stops at 3000 files', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/repos/acme/web/pulls/8/files`, ({ request }) => {
        calls++;
        const page = Number(new URL(request.url).searchParams.get('page'));
        return HttpResponse.json(Array.from({ length: 100 }, (_, i) => file((page - 1) * 100 + i)));
      }),
    );
    const files = await fetchPullRequestFiles(octokit(), 'acme', 'web', 8);
    expect(files).toHaveLength(3000);
    expect(calls).toBe(30);
  });

  it('maps statuses and missing patches', async () => {
    server.use(
      http.get(`${API}/repos/acme/web/pulls/9/files`, () =>
        HttpResponse.json([
          file(1, { status: 'added' }),
          file(2, { status: 'removed' }),
          file(3, { status: 'renamed' }),
          file(4, { status: 'copied' }),
          file(5, { status: 'changed' }),
          file(6, { status: 'modified', patch: undefined }), // binary
        ]),
      ),
    );
    const files = await fetchPullRequestFiles(octokit(), 'acme', 'web', 9);
    expect(files.map((f) => f.status)).toEqual([
      'added',
      'removed',
      'renamed',
      'added',
      'modified',
      'modified',
    ]);
    expect(files[5]?.patch).toBe('');
  });

  it('maps failures to github_error', async () => {
    server.use(
      http.get(`${API}/repos/acme/web/pulls/9/files`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    await expect(fetchPullRequestFiles(octokit(), 'acme', 'web', 9)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'github_error',
    });
  });
});

describe('fetchFileText', () => {
  const url = `${API}/repos/acme/web/contents/AGENTS.md`;

  it('decodes a base64 file at the ref', async () => {
    let ref: string | null = null;
    server.use(
      http.get(url, ({ request }) => {
        ref = new URL(request.url).searchParams.get('ref');
        return HttpResponse.json({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('# Rules\nBe nice ✓').toString('base64'),
        });
      }),
    );
    expect(await fetchFileText(octokit(), 'acme', 'web', 'AGENTS.md', 'abc')).toBe(
      '# Rules\nBe nice ✓',
    );
    expect(ref).toBe('abc');
  });

  it('returns null on 404, directories and oversized files', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })));
    expect(await fetchFileText(octokit(), 'acme', 'web', 'AGENTS.md', 'abc')).toBeNull();

    server.use(http.get(url, () => HttpResponse.json([{ type: 'file', name: 'x' }])));
    expect(await fetchFileText(octokit(), 'acme', 'web', 'AGENTS.md', 'abc')).toBeNull();

    server.use(
      http.get(url, () => HttpResponse.json({ type: 'file', encoding: 'none', content: '' })),
    );
    expect(await fetchFileText(octokit(), 'acme', 'web', 'AGENTS.md', 'abc')).toBeNull();
  });

  it('maps other failures to github_error', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'nope' }, { status: 500 })));
    await expect(fetchFileText(octokit(), 'acme', 'web', 'AGENTS.md', 'abc')).rejects.toMatchObject(
      {
        code: 'github_error',
      },
    );
  });
});

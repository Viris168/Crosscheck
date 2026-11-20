import { ProviderError } from '@app/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createOctokit,
  fetchOrgMembership,
  fetchRepoPermission,
  GithubApiError,
  isRepoCollaborator,
  listUserInstallationIds,
  fetchAuthenticatedUser,
  permissionAtLeast,
  toGithubError,
  type RepoPermission,
} from './index';

const API = 'https://api.github.com';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** No retries/throttling so error tests are fast and deterministic. */
const octokit = (auth = 'test-token') =>
  createOctokit({ auth, retry: { enabled: false }, throttle: { enabled: false } });

const notFound = () => HttpResponse.json({ message: 'Not Found' }, { status: 404 });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------- permissionAtLeast

describe('permissionAtLeast', () => {
  const order: RepoPermission[] = ['none', 'read', 'triage', 'write', 'maintain', 'admin'];

  it('follows none < read < triage < write < maintain < admin', () => {
    for (const [i, have] of order.entries()) {
      for (const [j, need] of order.entries()) {
        expect(permissionAtLeast(have, need), `${have} >= ${need}`).toBe(i >= j);
      }
    }
  });
});

// ---------------------------------------------------------------- fetchRepoPermission

describe('fetchRepoPermission', () => {
  const url = `${API}/repos/acme/web/collaborators/:user/permission`;
  const reply = (body: Record<string, unknown>) =>
    server.use(http.get(url, () => HttpResponse.json({ user: { login: 'octo' }, ...body })));

  it.each([
    ['admin', 'admin', 'admin'],
    ['write', 'maintain', 'maintain'],
    ['write', 'write', 'write'],
    ['read', 'triage', 'triage'],
    ['read', 'read', 'read'],
    ['none', 'none', 'none'],
  ] as const)('permission %s + role_name %s → %s', async (permission, role_name, expected) => {
    reply({ permission, role_name });
    await expect(fetchRepoPermission(octokit(), 'acme/web', 'octo')).resolves.toBe(expected);
  });

  it('maps a custom role through `permission`', async () => {
    reply({ permission: 'write', role_name: 'security-reviewer' });
    await expect(fetchRepoPermission(octokit(), 'acme/web', 'octo')).resolves.toBe('write');
  });

  it('falls back to `permission` when role_name is missing', async () => {
    reply({ permission: 'read' });
    await expect(fetchRepoPermission(octokit(), 'acme/web', 'octo')).resolves.toBe('read');
  });

  it('maps an unknown permission to none', async () => {
    reply({ permission: 'weird', role_name: 'weird' });
    await expect(fetchRepoPermission(octokit(), 'acme/web', 'octo')).resolves.toBe('none');
  });

  it('sends the login in the path', async () => {
    let seen = '';
    server.use(
      http.get(url, ({ params }) => {
        seen = String(params.user);
        return HttpResponse.json({ permission: 'read', role_name: 'read' });
      }),
    );
    await fetchRepoPermission(octokit(), 'acme/web', 'Octo-Cat');
    expect(seen).toBe('Octo-Cat');
  });

  it('maps 404 to none', async () => {
    server.use(http.get(url, notFound));
    await expect(fetchRepoPermission(octokit(), 'acme/web', 'octo')).resolves.toBe('none');
  });

  it('rethrows a 500 as GithubApiError with its status', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));
    const err = await caught(fetchRepoPermission(octokit(), 'acme/web', 'octo'));
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'github_error', status: 500 });
    // toGithubError passes it through unchanged.
    expect(toGithubError(err, 'x')).toBe(err);
  });

  it('never puts the token in the error', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));
    const err = (await caught(
      fetchRepoPermission(octokit('ghs_secret'), 'acme/web', 'o'),
    )) as Error;
    expect(err.message).not.toContain('ghs_secret');
  });
});

// ---------------------------------------------------------------- isRepoCollaborator

describe('isRepoCollaborator', () => {
  const url = `${API}/repos/acme/web/collaborators/octo`;

  it('is true on 204', async () => {
    server.use(http.get(url, () => new HttpResponse(null, { status: 204 })));
    await expect(isRepoCollaborator(octokit(), 'acme/web', 'octo')).resolves.toBe(true);
  });

  it('is false on 404', async () => {
    server.use(http.get(url, notFound));
    await expect(isRepoCollaborator(octokit(), 'acme/web', 'octo')).resolves.toBe(false);
  });

  it('rethrows a 500 with its status', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));
    const err = await caught(isRepoCollaborator(octokit(), 'acme/web', 'octo'));
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err).toMatchObject({ code: 'github_error', status: 500 });
  });
});

// ---------------------------------------------------------------- fetchOrgMembership

describe('fetchOrgMembership', () => {
  const url = `${API}/orgs/acme/memberships/octo`;
  const reply = (state: string, role: string) =>
    server.use(http.get(url, () => HttpResponse.json({ state, role, user: { login: 'octo' } })));

  it('returns the role of an active member', async () => {
    reply('active', 'member');
    await expect(fetchOrgMembership(octokit(), 'acme', 'octo')).resolves.toEqual({
      role: 'member',
    });
    reply('active', 'admin');
    await expect(fetchOrgMembership(octokit(), 'acme', 'octo')).resolves.toEqual({
      role: 'admin',
    });
  });

  it('returns null for a pending invitation', async () => {
    reply('pending', 'member');
    await expect(fetchOrgMembership(octokit(), 'acme', 'octo')).resolves.toBeNull();
  });

  it('returns null for a billing manager (not a member)', async () => {
    reply('active', 'billing_manager');
    await expect(fetchOrgMembership(octokit(), 'acme', 'octo')).resolves.toBeNull();
  });

  it('returns null on 404', async () => {
    server.use(http.get(url, notFound));
    await expect(fetchOrgMembership(octokit(), 'acme', 'octo')).resolves.toBeNull();
  });

  it('rethrows a 403 with status 403 (missing Members: read permission)', async () => {
    server.use(
      http.get(url, () =>
        HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 }),
      ),
    );
    const err = await caught(fetchOrgMembership(octokit(), 'acme', 'octo'));
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err).toMatchObject({ code: 'github_error', status: 403 });
  });
});

// ---------------------------------------------------------------- listUserInstallationIds

describe('listUserInstallationIds', () => {
  const url = `${API}/user/installations`;

  it('pages through every installation using the user token', async () => {
    const auths: (string | null)[] = [];
    const pages: string[] = [];
    server.use(
      http.get(url, ({ request }) => {
        auths.push(request.headers.get('authorization'));
        const page = new URL(request.url).searchParams.get('page') ?? '1';
        pages.push(page);
        const ids =
          page === '1'
            ? Array.from({ length: 100 }, (_, i) => i + 1)
            : page === '2'
              ? [101, 102]
              : [];
        return HttpResponse.json({
          total_count: 102,
          installations: ids.map((id) => ({ id })),
        });
      }),
    );
    const ids = await listUserInstallationIds('ghu_user');
    expect(ids).toHaveLength(102);
    expect(ids.slice(-2)).toEqual([101, 102]);
    expect(pages).toEqual(['1', '2']);
    expect(auths.every((a) => a === 'token ghu_user')).toBe(true);
  });

  it('returns [] when the user has no installations', async () => {
    server.use(http.get(url, () => HttpResponse.json({ total_count: 0, installations: [] })));
    await expect(listUserInstallationIds('ghu_user')).resolves.toEqual([]);
  });

  it('rethrows a 401 with its status and without the token', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'Bad creds' }, { status: 401 })));
    const err = (await caught(
      listUserInstallationIds('ghu_secret', { octokit: octokit('ghu_secret') }),
    )) as GithubApiError;
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain('ghu_secret');
  });
});

// ---------------------------------------------------------------- fetchAuthenticatedUser

describe('fetchAuthenticatedUser', () => {
  const url = `${API}/user`;

  it("returns the token owner's id, login and avatar", async () => {
    let auth: string | null = null;
    server.use(
      http.get(url, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ id: 7002, login: 'bob', avatar_url: 'https://avatars/bob' });
      }),
    );
    await expect(fetchAuthenticatedUser('ghu_user')).resolves.toEqual({
      id: 7002,
      login: 'bob',
      avatarUrl: 'https://avatars/bob',
    });
    expect(auth).toBe('token ghu_user');
  });

  it('rethrows a 401 with its status and without the token', async () => {
    server.use(http.get(url, () => HttpResponse.json({ message: 'Bad creds' }, { status: 401 })));
    const err = (await caught(
      fetchAuthenticatedUser('ghu_secret', { octokit: octokit('ghu_secret') }),
    )) as GithubApiError;
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain('ghu_secret');
  });
});

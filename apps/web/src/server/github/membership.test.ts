import { createOctokit } from '@app/github';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './__fixtures__/fake-db';

// ---------------------------------------------------------------- mocks

const USER_TOKEN = 'ghu_user_token_secret';

const h = vi.hoisted(() => {
  const state: { fake?: { db: unknown } } = {};
  const logs: unknown[][] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push([level, ...args]);
    };
  return {
    state,
    logs,
    logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
    getAccessToken: vi.fn(),
    getInstallationOctokit: vi.fn(),
  };
});

vi.mock('@app/db', () => ({
  prisma: new Proxy(
    {},
    { get: (_t, k) => (h.state.fake!.db as Record<string, unknown>)[k as string] },
  ),
}));
vi.mock('@/server/auth', () => ({ auth: { api: { getAccessToken: h.getAccessToken } } }));
vi.mock('@/server/logger', () => ({ logger: h.logger }));
vi.mock('@app/github', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInstallationOctokit: h.getInstallationOctokit,
}));

const { pruneRemovedMembers, syncUserMemberships } = await import('./membership');

// ---------------------------------------------------------------- GitHub (msw)

const API = 'https://api.github.com';
const server = setupServer();
/** Every GitHub request path we saw, to assert what was (not) asked. */
const requests: string[] = [];

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const notFound = () => HttpResponse.json({ message: 'Not Found' }, { status: 404 });

/** GitHub's `GET /user` answer for the user token. null = the stored user (bob, GitHub id 7002). */
let ghProfile: { id: number; login: string } | null = null;

function githubUser() {
  server.use(
    http.get(`${API}/user`, ({ request }) => {
      expect(request.headers.get('authorization')).toContain(USER_TOKEN);
      const p = ghProfile ?? { id: 7002, login: String(fake.tables.user[0]?.login ?? 'bob') };
      return HttpResponse.json({ ...p, avatar_url: `https://avatars/${p.login}` });
    }),
  );
}

/** `/user/installations` for the user token. */
function userInstallations(ids: number[]) {
  server.use(
    http.get(`${API}/user/installations`, ({ request }) => {
      expect(request.headers.get('authorization')).toContain(USER_TOKEN);
      return HttpResponse.json({
        total_count: ids.length,
        installations: ids.map((id) => ({ id })),
      });
    }),
  );
}

/** `/orgs/:org/memberships/:user`: login → membership, anything else 404. */
function orgMemberships(members: Record<string, { state: string; role: string } | number>) {
  server.use(
    http.get(`${API}/orgs/:org/memberships/:user`, ({ params }) => {
      const m = members[String(params.user)];
      if (m === undefined) return notFound();
      if (typeof m === 'number') return HttpResponse.json({ message: 'x' }, { status: m });
      return HttpResponse.json({ ...m, user: { login: params.user } });
    }),
  );
}

/** `/repos/:owner/:repo/collaborators/:user`: 204 for `fullName:login` pairs listed. */
function collaborators(pairs: string[], status?: number) {
  server.use(
    http.get(`${API}/repos/:owner/:repo/collaborators/:user`, ({ params }) => {
      if (status) return HttpResponse.json({ message: 'x' }, { status });
      const key = `${params.owner}/${params.repo}:${params.user}`;
      return pairs.includes(key) ? new HttpResponse(null, { status: 204 }) : notFound();
    }),
  );
}

// ---------------------------------------------------------------- data

let fake: FakeDb;
let instSeq = 0;

function addOrg(
  login: string,
  type: 'Organization' | 'User' | null,
  opts: { ghInstallationId: number; repos?: { fullName: string; active?: boolean }[] },
) {
  const orgId = `org-${login.toLowerCase()}`;
  fake.tables.organization.push({
    id: orgId,
    name: login,
    slug: login.toLowerCase(),
    githubAccountLogin: login,
    githubAccountType: type,
  });
  const inst = {
    id: `inst-${++instSeq}`,
    githubInstallationId: opts.ghInstallationId,
    orgId,
    needsMemberPermission: false,
    createdAt: new Date(Date.now() + instSeq),
  };
  fake.tables.installation.push(inst);
  for (const [i, r] of (opts.repos ?? [{ fullName: `${login}/web` }]).entries()) {
    fake.tables.repo.push({
      id: `repo-${inst.id}-${i}`,
      githubRepoId: opts.ghInstallationId * 10 + i,
      fullName: r.fullName,
      orgId,
      installationId: inst.id,
      active: r.active ?? true,
    });
  }
  return { orgId, inst };
}

function addMember(orgId: string, userId: string, role: string) {
  fake.tables.member.push({ id: `m-${orgId}-${userId}`, organizationId: orgId, userId, role });
}

const roleOf = (orgId: string, userId: string) =>
  fake.tables.member.find((m) => m.organizationId === orgId && m.userId === userId)?.role;

beforeEach(() => {
  fake = createFakeDb();
  h.state.fake = fake;
  h.logs.length = 0;
  requests.length = 0;
  h.getAccessToken.mockReset().mockResolvedValue({ accessToken: USER_TOKEN });
  h.getInstallationOctokit.mockReset().mockImplementation(async () =>
    createOctokit({
      auth: 'inst-token',
      retry: { enabled: false },
      throttle: { enabled: false },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }),
  );
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    requests.push(new URL(request.url).pathname);
  });
  fake.tables.user.push({ id: 'u-bob', login: 'bob' });
  fake.tables.account.push({
    id: 'acc-bob',
    providerId: 'github',
    accountId: '7002',
    userId: 'u-bob',
  });
  ghProfile = null;
  githubUser();
  userInstallations([]);
});

// ---------------------------------------------------------------- org installs

describe('syncUserMemberships: org install', () => {
  it('a GitHub org member joins as member', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    addMember(orgId, 'u-alice', 'owner');
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [orgId], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
  });

  it('a plain member does not become owner even when the org has no owner', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    await syncUserMemberships('u-bob');
    expect(roleOf(orgId, 'u-bob')).toBe('member');
  });

  it('a GitHub org admin joins as owner when the org has no owner (install before sign-in)', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'admin' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [orgId], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('owner');
  });

  it('a GitHub org admin joins as member when the org already has an owner', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    addMember(orgId, 'u-alice', 'owner');
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'admin' } });

    await syncUserMemberships('u-bob');
    expect(roleOf(orgId, 'u-bob')).toBe('member');
    expect(fake.tables.member.filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  it('an outside collaborator (not an org member) does not join', async () => {
    addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({});
    collaborators(['Acme/web:bob']);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(fake.tables.member).toHaveLength(0);
    expect(requests.some((p) => p.includes('/collaborators/'))).toBe(false);
  });

  it('a pending invitation does not join', async () => {
    addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'pending', role: 'member' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
  });

  it.each(['member', 'admin', 'owner'])(
    'removed on GitHub: the %s row is deleted',
    async (role) => {
      const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
      addMember(orgId, 'u-bob', role);
      orgMemberships({});

      expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [orgId] });
      expect(roleOf(orgId, 'u-bob')).toBeUndefined();
    },
  );

  it('an existing member stays, with their role unchanged', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    addMember(orgId, 'u-bob', 'admin');
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('admin');
  });

  it('is safe to run repeatedly', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'admin' } });

    await syncUserMemberships('u-bob');
    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(fake.tables.member).toHaveLength(1);
    expect(roleOf(orgId, 'u-bob')).toBe('owner');
  });
});

// ---------------------------------------------------------------- personal installs

describe('syncUserMemberships: personal install', () => {
  const repos = [{ fullName: 'carol/app' }, { fullName: 'carol/site' }];

  it('the account itself joins as owner, with no collaborator call', async () => {
    fake.tables.user[0]!.login = 'Carol';
    const { orgId } = addOrg('carol', 'User', { ghInstallationId: 2, repos });
    userInstallations([2]);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [orgId], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('owner');
    expect(requests.some((p) => p.includes('/collaborators/'))).toBe(false);
  });

  it('a collaborator on any active repo joins as member', async () => {
    const { orgId } = addOrg('carol', 'User', { ghInstallationId: 2, repos });
    userInstallations([2]);
    collaborators(['carol/site:bob']);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [orgId], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
  });

  it('checks repos 5 at a time and stops after the batch with a hit', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ fullName: `carol/r${i + 10}` }));
    addOrg('carol', 'User', { ghInstallationId: 2, repos: many });
    userInstallations([2]);
    collaborators(['carol/r11:bob']);

    await syncUserMemberships('u-bob');
    // Repos are checked in name order: r10..r14 is the first batch, and r11 is in it.
    expect(requests.filter((p) => p.includes('/collaborators/')).sort()).toEqual(
      ['r10', 'r11', 'r12', 'r13', 'r14'].map((r) => `/repos/carol/${r}/collaborators/bob`),
    );
  });

  it('a stranger does not join, even on a public repo where GitHub reports read', async () => {
    addOrg('carol', 'User', { ghInstallationId: 2, repos });
    userInstallations([2]);
    collaborators([]);
    // Public repos report `read` for everyone: the sync must not use this endpoint.
    server.use(
      http.get(`${API}/repos/:owner/:repo/collaborators/:user/permission`, () =>
        HttpResponse.json({ permission: 'read', role_name: 'read' }),
      ),
    );

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(fake.tables.member).toHaveLength(0);
    expect(requests.some((p) => p.endsWith('/permission'))).toBe(false);
  });

  it('a collaborator removed from every repo leaves', async () => {
    const { orgId } = addOrg('carol', 'User', { ghInstallationId: 2, repos });
    addMember(orgId, 'u-bob', 'member');
    collaborators([]);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [orgId] });
  });

  it('ignores inactive repos', async () => {
    addOrg('carol', 'User', {
      ghInstallationId: 2,
      repos: [{ fullName: 'carol/app' }, { fullName: 'carol/old', active: false }],
    });
    userInstallations([2]);
    collaborators(['carol/old:bob']);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
  });
});

// ---------------------------------------------------------------- candidates

describe('syncUserMemberships: candidates', () => {
  it('only checks /user/installations and orgs the user is already in', async () => {
    addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    const other = addOrg('Other', 'Organization', { ghInstallationId: 3 });
    addMember(other.orgId, 'u-bob', 'member');
    addOrg('Stranger', 'Organization', { ghInstallationId: 4 });
    userInstallations([1, 999]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    await syncUserMemberships('u-bob');
    const orgs = requests.filter((p) => p.startsWith('/orgs/'));
    expect(orgs.sort()).toEqual(['/orgs/Acme/memberships/bob', '/orgs/Other/memberships/bob']);
  });

  it("asks Better Auth for the token of the user's GitHub account row", async () => {
    await syncUserMemberships('u-bob');
    expect(h.getAccessToken).toHaveBeenCalledWith({
      body: { accountId: 'acc-bob', userId: 'u-bob' },
    });
  });

  it.each([
    ['getAccessToken throws', () => h.getAccessToken.mockRejectedValue(new Error('no account'))],
    ['empty token', () => h.getAccessToken.mockResolvedValue({ accessToken: '' })],
    ['no GitHub account linked', () => (fake.tables.account.length = 0)],
    [
      '/user/installations fails',
      () =>
        server.use(
          http.get(`${API}/user/installations`, () =>
            HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
          ),
        ),
    ],
  ])('no usable user token (%s): removals only', async (_name, setup) => {
    const acme = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    const gone = addOrg('Gone', 'Organization', { ghInstallationId: 3 });
    addMember(gone.orgId, 'u-bob', 'member');
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });
    server.use(http.get(`${API}/orgs/Gone/memberships/:user`, notFound));
    setup();

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [gone.orgId] });
    expect(roleOf(acme.orgId, 'u-bob')).toBeUndefined();
  });

  it('skips installations whose org has no active repo', async () => {
    addOrg('Acme', 'Organization', {
      ghInstallationId: 1,
      repos: [{ fullName: 'Acme/web', active: false }],
    });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(requests.some((p) => p.startsWith('/orgs/'))).toBe(false);
  });

  it('does nothing when there is no stored login and no usable token', async () => {
    fake.tables.user[0]!.login = null;
    h.getAccessToken.mockRejectedValue(new Error('no account'));
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    addMember(orgId, 'u-bob', 'member');

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- login from GitHub

describe('syncUserMemberships: login from GitHub', () => {
  // better-auth drops `input: false` fields from mapProfileToUser, so new users have no login.
  it('fills a missing login from GET /user, then syncs with it', async () => {
    fake.tables.user[0]!.login = null;
    ghProfile = { id: 7002, login: 'bob' };
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [orgId], left: [] });
    expect(fake.tables.user[0]).toMatchObject({ login: 'bob', avatarUrl: 'https://avatars/bob' });
  });

  it('follows a GitHub rename', async () => {
    fake.tables.user[0]!.login = 'bob-old';
    ghProfile = { id: 7002, login: 'bob' };
    addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    await syncUserMemberships('u-bob');
    expect(fake.tables.user[0]!.login).toBe('bob');
    expect(requests).toContain('/orgs/Acme/memberships/bob');
  });

  it('ignores a profile whose id is not the linked account', async () => {
    fake.tables.user[0]!.login = null;
    ghProfile = { id: 9999, login: 'mallory' };
    addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(fake.tables.user[0]!.login).toBeNull();
    expect(requests.some((p) => p.startsWith('/orgs/'))).toBe(false);
  });

  it('uses the stored login when GET /user fails', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [orgId], left: [] });
    expect(fake.tables.user[0]!.login).toBe('bob');
  });
});

// ---------------------------------------------------------------- skips + errors

describe('syncUserMemberships: skips and errors', () => {
  it('skips an org with a null githubAccountType (no GitHub call, rows unchanged)', async () => {
    const { orgId } = addOrg('Acme', null, { ghInstallationId: 1 });
    addMember(orgId, 'u-bob', 'member');
    userInstallations([1]);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
    expect(requests.some((p) => p.startsWith('/orgs/'))).toBe(false);
  });

  it('a GitHub 500 changes nothing (no join, no removal)', async () => {
    const acme = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    const other = addOrg('Other', 'Organization', { ghInstallationId: 3 });
    addMember(other.orgId, 'u-bob', 'member');
    userInstallations([1]);
    orgMemberships({ bob: 500 });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(acme.orgId, 'u-bob')).toBeUndefined();
    expect(roleOf(other.orgId, 'u-bob')).toBe('member');
  });

  it('a collaborator-check 500 on a personal install changes nothing', async () => {
    const { orgId } = addOrg('carol', 'User', { ghInstallationId: 2 });
    addMember(orgId, 'u-bob', 'member');
    collaborators([], 500);

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
  });

  it('one failing org does not stop the others', async () => {
    const broken = addOrg('Broken', 'Organization', { ghInstallationId: 1 });
    const acme = addOrg('Acme', 'Organization', { ghInstallationId: 3 });
    userInstallations([1, 3]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });
    server.use(
      http.get(`${API}/orgs/Broken/memberships/:user`, () =>
        HttpResponse.json({ message: 'x' }, { status: 502 }),
      ),
    );

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [acme.orgId], left: [] });
    expect(roleOf(broken.orgId, 'u-bob')).toBeUndefined();
  });

  it('a 403 on the org call sets needsMemberPermission and changes nothing', async () => {
    const { orgId, inst } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    addMember(orgId, 'u-bob', 'member');
    orgMemberships({ bob: 403 });

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
    expect(inst.needsMemberPermission).toBe(true);
  });

  it('a failed database write skips the org', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });
    fake.hooks.beforeTransaction = () => {
      throw new Error('serialization failure');
    };

    expect(await syncUserMemberships('u-bob')).toEqual({ joined: [], left: [] });
    expect(roleOf(orgId, 'u-bob')).toBeUndefined();
  });

  it('never logs tokens; log context is userId/orgId only', async () => {
    const { orgId } = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    addMember(orgId, 'u-bob', 'member');
    userInstallations([1]);
    orgMemberships({ bob: 403 });

    await syncUserMemberships('u-bob');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const [, ctx] of h.logs) {
      expect(JSON.stringify(ctx)).not.toContain(USER_TOKEN);
      expect(JSON.stringify(ctx)).not.toContain('inst-token');
      if (ctx && typeof ctx === 'object') {
        expect(Object.keys(ctx).every((k) => ['userId', 'orgId', 'err'].includes(k))).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------- scheduled prune

describe('syncUserMemberships: removalsOnly', () => {
  it("never uses the user's token and never joins", async () => {
    const acme = addOrg('Acme', 'Organization', { ghInstallationId: 1 });
    userInstallations([1]);
    orgMemberships({ bob: { state: 'active', role: 'member' } });

    expect(await syncUserMemberships('u-bob', { removalsOnly: true })).toEqual({
      joined: [],
      left: [],
    });
    expect(h.getAccessToken).not.toHaveBeenCalled();
    expect(roleOf(acme.orgId, 'u-bob')).toBeUndefined();
    expect(requests).not.toContain('/user');
  });

  it('removes a membership GitHub no longer backs, using the stored login', async () => {
    const repos = [{ fullName: 'carol/app' }];
    const { orgId } = addOrg('carol', 'User', { ghInstallationId: 2, repos });
    addMember(orgId, 'u-bob', 'member');
    collaborators([]);

    expect(await syncUserMemberships('u-bob', { removalsOnly: true })).toEqual({
      joined: [],
      left: [orgId],
    });
    expect(requests).toContain('/repos/carol/app/collaborators/bob');
  });
});

describe('pruneRemovedMembers', () => {
  it('re-checks every member once and removes only those GitHub no longer lists', async () => {
    const repos = [{ fullName: 'carol/app' }];
    const { orgId } = addOrg('carol', 'User', { ghInstallationId: 2, repos });
    fake.tables.user.push({ id: 'u-dan', login: 'dan' });
    addMember(orgId, 'u-carol', 'owner');
    addMember(orgId, 'u-bob', 'member');
    addMember(orgId, 'u-dan', 'member');
    fake.tables.user.push({ id: 'u-carol', login: 'carol' });
    collaborators(['carol/app:dan']);

    expect(await pruneRemovedMembers()).toEqual({ users: 3, left: 1 });
    expect(roleOf(orgId, 'u-bob')).toBeUndefined();
    expect(roleOf(orgId, 'u-dan')).toBe('member');
    expect(roleOf(orgId, 'u-carol')).toBe('owner');
    expect(h.getAccessToken).not.toHaveBeenCalled();
  });

  it('a GitHub error changes nothing', async () => {
    const { orgId } = addOrg('carol', 'User', {
      ghInstallationId: 2,
      repos: [{ fullName: 'carol/app' }],
    });
    addMember(orgId, 'u-bob', 'member');
    collaborators([], 403);

    expect(await pruneRemovedMembers()).toEqual({ users: 1, left: 0 });
    expect(roleOf(orgId, 'u-bob')).toBe('member');
  });
});

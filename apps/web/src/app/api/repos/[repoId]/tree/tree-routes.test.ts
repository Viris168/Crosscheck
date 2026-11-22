import {
  ApiErrorSchema,
  GetTreeResponse,
  HttpError,
  SetCompareWithResponse,
  SyncTreeResponse,
  type MemberRole,
} from '@app/shared';
import type * as GithubModule from '@app/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedBranches, seedSnapshot, SEED_SHA } from '@/components/tree/__fixtures__/seed-snapshot';

// ---------------------------------------------------------------- mocks

const db = vi.hoisted(() => ({
  repo: { findUnique: vi.fn() },
  repoGraph: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  branch: { findMany: vi.fn() },
  pullRequest: { findMany: vi.fn() },
  compareOverride: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  gitEvent: { findFirst: vi.fn() },
}));
vi.mock('@app/db', () => ({ prisma: db }));

const auth = vi.hoisted(() => ({
  user: null as string | null,
  roles: new Map<string, MemberRole>(),
}));
vi.mock('@/server/auth', () => ({
  requireSession: vi.fn(async () => {
    if (!auth.user) throw new HttpError('unauthorized', 'Sign in required');
    return { user: { id: auth.user }, session: {} };
  }),
  requireOrgMember: vi.fn(async (userId: string, orgId: string) => {
    const role = auth.roles.get(`${userId}:${orgId}`);
    if (!role) throw new HttpError('forbidden', 'Not a member of this organization');
    return { id: 'm', role };
  }),
}));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/server/logger', () => ({ logger: log }));

/** `CompareOverride` rows, keyed by branch name (repo r1). */
const overrides = vi.hoisted(() => new Map<string, string>());

const send = vi.hoisted(() => vi.fn());
const recordTreeView = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/server/jobs', () => ({
  requestTreeSync: (repoId: string, orgId: string, reason: string) =>
    send({ name: 'tree/sync-requested', data: { repoId, orgId, reason } }),
  recordTreeView,
  loadTreeGraph: vi.fn(async () => null),
  treeCloneDir: () => '/nonexistent/1.git',
}));

const perm = vi.hoisted(() => ({ getRepoCollaborator: vi.fn(), getRepoPermission: vi.fn() }));
vi.mock('@/server/github', async () => ({
  getRepoCollaborator: perm.getRepoCollaborator,
  getRepoPermission: perm.getRepoPermission,
  permissionAtLeast: (await vi.importActual<typeof GithubModule>('@app/github')).permissionAtLeast,
}));

/** In-memory Redis: SET NX EX + DEL. */
const redis = vi.hoisted(() => {
  const keys = new Map<string, number>();
  return {
    keys,
    down: false,
    set: vi.fn(async (key: string, _v: string, _ex: 'EX', seconds: number, _nx: 'NX') => {
      if (redis.down) throw new Error('ECONNREFUSED');
      const exp = keys.get(key);
      if (exp && exp > Date.now()) return null;
      keys.set(key, Date.now() + seconds * 1000);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
  };
});
vi.mock('@/server/redis', () => ({ getRedis: () => redis }));

const { GET } = await import('./route');
const { POST } = await import('./sync/route');
const { PUT } = await import('./compare-with/route');

// ---------------------------------------------------------------- fixtures

const repo = {
  id: 'r1',
  orgId: 'org1',
  githubRepoId: 1,
  fullName: 'acme/web',
  installation: { id: 'inst1', githubInstallationId: 7 },
};
const graph = {
  repoId: 'r1',
  status: 'ready',
  errorCode: null,
  defaultBranch: 'main',
  syncedAt: new Date('2026-11-20T10:00:00Z'),
  snapshot: seedSnapshot(),
  updatedAt: new Date(),
};

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
const ctx = (repoId = 'r1') => ({ params: Promise.resolve({ repoId }) });
const errCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;
const getTree = (repoId = 'r1') => GET(req(`/api/repos/${repoId}/tree`), ctx(repoId));
const postSync = (repoId = 'r1') =>
  POST(req(`/api/repos/${repoId}/tree/sync`, { method: 'POST' }), ctx(repoId));

const putCompare = (body: unknown, repoId = 'r1') =>
  PUT(
    req(`/api/repos/${repoId}/tree/compare-with`, { method: 'PUT', body: JSON.stringify(body) }),
    ctx(repoId),
  );

beforeEach(() => {
  vi.clearAllMocks();
  overrides.clear();
  db.compareOverride.findMany.mockImplementation(async () =>
    [...overrides].map(([branchName, compareWith]) => ({ branchName, compareWith })),
  );
  db.compareOverride.upsert.mockImplementation(
    async ({ create }: { create: { branchName: string; compareWith: string } }) => {
      overrides.set(create.branchName, create.compareWith);
      return create;
    },
  );
  db.compareOverride.deleteMany.mockImplementation(
    async ({ where }: { where: { branchName: string } }) => ({
      count: overrides.delete(where.branchName) ? 1 : 0,
    }),
  );
  db.branch.findMany.mockImplementation(async ({ where }: { where: { name?: { in: string[] } } }) =>
    seedBranches
      .filter((b) => !where.name || where.name.in.includes(b.name))
      .map((b) => ({ name: b.name, isDefault: b.isDefault, recordedParents: [] })),
  );
  db.pullRequest.findMany.mockResolvedValue([
    { number: 1, headRef: 'chore/readme', baseRef: 'main', state: 'merged', headSha: SEED_SHA.e1 },
    { number: 2, headRef: 'feature/login', baseRef: 'dev', state: 'open', headSha: SEED_SHA.f3 },
    { number: 3, headRef: 'hotfix/header', baseRef: 'main', state: 'open', headSha: SEED_SHA.a1 },
  ]);
  redis.keys.clear();
  redis.down = false;
  auth.user = 'u1';
  auth.roles = new Map([['u1:org1', 'member']]);
  db.repo.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'r1' ? repo : null,
  );
  db.user.findUnique.mockResolvedValue({ login: 'octo' });
  db.repoGraph.findUnique.mockResolvedValue(graph);
  db.gitEvent.findFirst.mockResolvedValue({ id: 'ev1' });
  perm.getRepoCollaborator.mockResolvedValue(true);
  perm.getRepoPermission.mockResolvedValue('read');
  send.mockResolvedValue({ ids: ['e1'] });
});

// ---------------------------------------------------------------- GET /tree

describe('GET /api/repos/:repoId/tree', () => {
  it('401 without a session', async () => {
    auth.user = null;
    const res = await getTree();
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('unauthorized');
  });

  it('403 for an org member who is not a collaborator on the repo', async () => {
    perm.getRepoCollaborator.mockResolvedValue(false);
    const res = await getTree();
    expect(res.status).toBe(403);
    expect(db.repoGraph.findUnique).not.toHaveBeenCalled();
  });

  it('404 for an unknown repo', async () => {
    const res = await getTree('nope');
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('not_found');
  });

  it('returns the stored snapshot, valid against GetTreeResponse', async () => {
    const res = await getTree();
    expect(res.status).toBe(200);
    const body = GetTreeResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ready', errorCode: null, canEdit: false });
    expect(body.syncedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(body.snapshot?.branches).toHaveLength(6);
    expect(send).not.toHaveBeenCalled();
  });

  it('records the view (tree-cron, tree-cleanup), also on a 304; not for someone without access', async () => {
    const etag = (await getTree()).headers.get('etag')!;
    expect(recordTreeView).toHaveBeenLastCalledWith('r1');
    recordTreeView.mockClear();
    const res = await GET(req('/api/repos/r1/tree', { headers: { 'if-none-match': etag } }), ctx());
    expect(res.status).toBe(304);
    expect(recordTreeView).toHaveBeenCalledTimes(1);
    recordTreeView.mockClear();
    perm.getRepoCollaborator.mockResolvedValue(false);
    expect((await getTree()).status).toBe(403);
    expect(recordTreeView).not.toHaveBeenCalled();
  });

  it('canEdit is true for a writer', async () => {
    perm.getRepoPermission.mockResolvedValue('write');
    const body = GetTreeResponse.parse(await (await getTree()).json());
    expect(body.canEdit).toBe(true);
  });

  it('first view sends tree/sync-requested once and reports syncing', async () => {
    db.repoGraph.findUnique.mockResolvedValue(null);
    const first = GetTreeResponse.parse(await (await getTree()).json());
    expect(first).toEqual({
      status: 'syncing',
      syncedAt: null,
      errorCode: null,
      snapshot: null,
      canEdit: false,
      viewerLogin: null,
      liveEvents: true, // no snapshot yet, so no rows to filter: the login is not looked up
    });

    await getTree();
    await getTree();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: 'tree/sync-requested',
      data: { repoId: 'r1', orgId: 'org1', reason: 'first_view' },
    });
  });

  it('frees the first-view slot when the event could not be sent', async () => {
    db.repoGraph.findUnique.mockResolvedValue(null);
    send.mockRejectedValueOnce(new Error('inngest down'));
    expect((await getTree()).status).toBe(500);
    expect((await getTree()).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a stored snapshot that no longer parses is reported as failed, not a 500', async () => {
    db.repoGraph.findUnique.mockResolvedValue({ ...graph, snapshot: { nope: true } });
    const body = GetTreeResponse.parse(await (await getTree()).json());
    expect(body).toMatchObject({ status: 'failed', errorCode: 'internal', snapshot: null });
  });

  it('passes through a failed sync with its error code', async () => {
    db.repoGraph.findUnique.mockResolvedValue({
      ...graph,
      status: 'failed',
      errorCode: 'github_error',
    });
    const body = GetTreeResponse.parse(await (await getTree()).json());
    expect(body).toMatchObject({ status: 'failed', errorCode: 'github_error' });
    expect(body.snapshot).not.toBeNull();
  });
});

// ---------------------------------------------------------------- POST /tree/sync

describe('GET /tree conditional requests (T5c)', () => {
  const getIf = (etag: string | null) =>
    GET(
      req('/api/repos/r1/tree', etag ? { headers: { 'if-none-match': etag } } : undefined),
      ctx(),
    );

  it('sends a weak ETag and no-cache', async () => {
    const res = await getIf(null);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"[\w-]+"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('answers 304 with no body when the tree has not changed', async () => {
    const etag = (await getIf(null)).headers.get('etag')!;
    const res = await getIf(etag);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(etag);
    // also matches inside a list and without the weak prefix
    expect((await getIf(`"nope", ${etag.slice(2)}`)).status).toBe(304);
  });

  it('a new sync (syncedAt) answers 200 with a new ETag', async () => {
    const etag = (await getIf(null)).headers.get('etag')!;
    db.repoGraph.findUnique.mockResolvedValue({
      ...graph,
      syncedAt: new Date('2026-11-20T10:00:05Z'),
    });
    const res = await getIf(etag);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(etag);
    GetTreeResponse.parse(await res.json());
  });

  it('a status change without a new syncedAt (updatedAt) answers 200', async () => {
    const etag = (await getIf(null)).headers.get('etag')!;
    db.repoGraph.findUnique.mockResolvedValue({
      ...graph,
      status: 'syncing',
      updatedAt: new Date(graph.updatedAt.getTime() + 1000),
    });
    const res = await getIf(etag);
    expect(res.status).toBe(200);
    expect(GetTreeResponse.parse(await res.json()).status).toBe('syncing');
  });

  it('an override set since (applied at read time) answers 200', async () => {
    const etag = (await getIf(null)).headers.get('etag')!;
    overrides.set('feature/login-oauth', 'dev');
    expect((await getIf(etag)).status).toBe(200);
  });

  it('a different edit right answers 200', async () => {
    const etag = (await getIf(null)).headers.get('etag')!;
    perm.getRepoPermission.mockResolvedValue('write');
    expect((await getIf(etag)).status).toBe(200);
  });

  it('access is checked before any 304', async () => {
    const etag = (await getIf(null)).headers.get('etag')!;
    perm.getRepoCollaborator.mockResolvedValue(false);
    expect((await getIf(etag)).status).toBe(403);
  });

  it('reports whether git events arrive for the repo, in the body', async () => {
    const live = await getIf(null);
    expect(GetTreeResponse.parse(await live.json()).liveEvents).toBe(true);
    expect(live.headers.has('x-tree-live-events')).toBe(false);
    db.gitEvent.findFirst.mockResolvedValue(null);
    // The first event changes the ETag, so a polling page sees the flag flip.
    const none = await getIf(live.headers.get('etag'));
    expect(none.status).toBe(200);
    expect(GetTreeResponse.parse(await none.json()).liveEvents).toBe(false);
    expect(db.gitEvent.findFirst).toHaveBeenCalledWith({
      // check_suite / pull_request events arrive without a Push subscription: they don't count
      where: {
        repoId: 'r1',
        kind: { in: ['push', 'branch_created', 'branch_deleted', 'force_push'] },
      },
      select: { id: true },
    });
  });
});

describe('POST /api/repos/:repoId/tree/sync', () => {
  it('401 without a session', async () => {
    auth.user = null;
    expect((await postSync()).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('403 for a non-collaborator; nothing is sent', async () => {
    perm.getRepoCollaborator.mockResolvedValue(false);
    expect((await postSync()).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('queues a manual sync for a viewer', async () => {
    const res = await postSync();
    expect(res.status).toBe(200);
    expect(SyncTreeResponse.parse(await res.json())).toEqual({ queued: true });
    expect(send).toHaveBeenCalledWith({
      name: 'tree/sync-requested',
      data: { repoId: 'r1', orgId: 'org1', reason: 'manual' },
    });
  });

  it('429 on a second request within a minute', async () => {
    expect((await postSync()).status).toBe(200);
    const res = await postSync();
    expect(res.status).toBe(429);
    expect(await errCode(res)).toBe('rate_limited');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the limit is per repo and per minute', async () => {
    expect((await postSync()).status).toBe(200);
    const [key] = [...redis.keys.keys()];
    expect(key).toBe('tree:sync:rl:r1');
    redis.keys.set(key!, Date.now() - 1); // window over
    expect((await postSync()).status).toBe(200);
  });

  it('lets the request through when Redis is down', async () => {
    redis.down = true;
    expect((await postSync()).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- PUT /tree/compare-with

describe('PUT /api/repos/:repoId/tree/compare-with', () => {
  beforeEach(() => perm.getRepoPermission.mockResolvedValue('write'));

  const branchOf = (body: GetTreeResponse, name: string) =>
    body.snapshot!.branches.find((b) => b.name === name)!;

  it('401 without a session', async () => {
    auth.user = null;
    expect((await putCompare({ branch: 'dev', compareWith: 'main' })).status).toBe(401);
  });

  it('403 without write access; nothing is stored', async () => {
    perm.getRepoPermission.mockResolvedValue('read');
    const res = await putCompare({ branch: 'feature/login-oauth', compareWith: 'feature/login' });
    expect(res.status).toBe(403);
    expect(db.compareOverride.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['self', { branch: 'dev', compareWith: 'dev' }],
    ['unknown branch', { branch: 'nope', compareWith: 'main' }],
    ['unknown target', { branch: 'dev', compareWith: 'nope' }],
    ['default branch', { branch: 'main', compareWith: 'dev' }],
    ['cycle', { branch: 'dev', compareWith: 'feature/login' }],
    ['cycle through two branches', { branch: 'dev', compareWith: 'feature/login-oauth' }],
    ['bad body', { branch: '' }],
  ])('400 on %s', async (_label, body) => {
    const res = await putCompare(body);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('bad_request');
    expect(db.compareOverride.upsert).not.toHaveBeenCalled();
  });

  it('409 when the tree has not been built yet', async () => {
    db.repoGraph.findUnique.mockResolvedValue(null);
    const res = await putCompare({ branch: 'feature/login-oauth', compareWith: 'feature/login' });
    expect(res.status).toBe(409);
  });

  it('stores the override and returns the recomputed branch', async () => {
    const res = await putCompare({ branch: 'feature/login-oauth', compareWith: 'feature/login' });
    expect(res.status).toBe(200);
    const { branch } = SetCompareWithResponse.parse(await res.json());
    expect(branch).toMatchObject({
      name: 'feature/login-oauth',
      compareWith: 'feature/login',
      why: 'override',
      ahead: 1,
      behind: 1,
      mergeBase: SEED_SHA.f2,
    });
    expect(db.compareOverride.upsert).toHaveBeenCalledWith({
      where: { repoId_branchName: { repoId: 'r1', branchName: 'feature/login-oauth' } },
      create: {
        repoId: 'r1',
        branchName: 'feature/login-oauth',
        compareWith: 'feature/login',
        setByUserId: 'u1',
      },
      update: { compareWith: 'feature/login', setByUserId: 'u1' },
    });
  });

  it('logs the rule that picked before, without branch names', async () => {
    await putCompare({ branch: 'feature/login-oauth', compareWith: 'feature/login' });
    expect(log.info).toHaveBeenCalledWith(
      { repoId: 'r1', whyBefore: 'inferred', cleared: false },
      'compare-with override',
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('feature/');
  });

  it('GET shows the override at once, without a sync', async () => {
    await putCompare({ branch: 'feature/login-oauth', compareWith: 'feature/login' });
    const body = GetTreeResponse.parse(await (await getTree()).json());
    expect(branchOf(body, 'feature/login-oauth')).toMatchObject({
      compareWith: 'feature/login',
      why: 'override',
      ahead: 1,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('the override survives a sync that wrote a fresh snapshot', async () => {
    overrides.set('feature/login-oauth', 'feature/login');
    // A sync writes a new snapshot; the row is untouched, and GET still applies it.
    db.repoGraph.findUnique.mockResolvedValue({ ...graph, snapshot: seedSnapshot() });
    const body = GetTreeResponse.parse(await (await getTree()).json());
    expect(branchOf(body, 'feature/login-oauth')).toMatchObject({
      compareWith: 'feature/login',
      why: 'override',
    });
  });

  it('reset (null) removes the row and goes back to the automatic pick', async () => {
    overrides.set('feature/login-oauth', 'feature/login');
    const stored = seedSnapshot();
    stored.branches = stored.branches.map((b) =>
      b.name === 'feature/login-oauth'
        ? { ...b, compareWith: 'feature/login', why: 'override' as const, ahead: 1, behind: 1 }
        : b,
    );
    db.repoGraph.findUnique.mockResolvedValue({ ...graph, snapshot: stored });

    const res = await putCompare({ branch: 'feature/login-oauth', compareWith: null });
    expect(res.status).toBe(200);
    const { branch } = SetCompareWithResponse.parse(await res.json());
    expect(branch).toMatchObject({ compareWith: 'dev', why: 'inferred', ahead: 3, behind: 1 });
    expect(overrides.has('feature/login-oauth')).toBe(false);

    const body = GetTreeResponse.parse(await (await getTree()).json());
    expect(branchOf(body, 'feature/login-oauth')).toMatchObject({
      compareWith: 'dev',
      why: 'inferred',
    });
  });
});

// T6b: GET /tree/compare (auth + Redis cache by head SHAs), GET /tree?visible= (lazy counts), the
// "mine" header, and the T6a engine mock.
import { CommitGraph } from '@app/git-graph';
import {
  ApiErrorSchema,
  CompareResponse,
  GetTreeResponse,
  HttpError,
  type MemberRole,
} from '@app/shared';
import type * as GithubModule from '@app/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedBranches, seedSnapshot, SEED_SHA } from '@/components/tree/__fixtures__/seed-snapshot';
import { scaleRepo, scaleSnapshot } from '@/components/tree/__fixtures__/scale-repo';
import { NOT_COMPUTED } from '@/components/tree/scale-contract';

// ---------------------------------------------------------------- mocks

const db = vi.hoisted(() => ({
  repo: { findUnique: vi.fn() },
  repoGraph: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  branch: { findMany: vi.fn() },
  pullRequest: { findMany: vi.fn() },
  compareOverride: { findMany: vi.fn() },
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

vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/jobs', () => ({ inngest: { send: vi.fn() } }));

const perm = vi.hoisted(() => ({ getRepoCollaborator: vi.fn(), getRepoPermission: vi.fn() }));
vi.mock('@/server/github', async () => ({
  getRepoCollaborator: perm.getRepoCollaborator,
  getRepoPermission: perm.getRepoPermission,
  permissionAtLeast: (await vi.importActual<typeof GithubModule>('@app/github')).permissionAtLeast,
}));

/** In-memory Redis: GET + SET with EX (and NX for the sync slots). */
const redis = vi.hoisted(() => {
  const store = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    return e && e.exp > Date.now() ? e : undefined;
  };
  return {
    store,
    down: false,
    get: vi.fn(async (k: string) => {
      if (redis.down) throw new Error('ECONNREFUSED');
      return live(k)?.v ?? null;
    }),
    set: vi.fn(async (k: string, v: string, _ex: 'EX', seconds: number, nx?: 'NX') => {
      if (redis.down) throw new Error('ECONNREFUSED');
      if (nx && live(k)) return null;
      store.set(k, { v, exp: Date.now() + seconds * 1000 });
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
});
vi.mock('@/server/redis', () => ({ getRedis: () => redis }));

const graphs = vi.hoisted(() => ({ loadCommitGraph: vi.fn() }));
vi.mock('./graph-source', () => graphs);

const { GET: getCompare, COMPARE_CACHE_SECONDS, compareCacheKey } = await import('./compare/route');
const { GET: getTree } = await import('./route');
const { buildSnapshot, compare } = await import('@app/git-graph');

// ---------------------------------------------------------------- fixtures

const repo = {
  id: 'r1',
  orgId: 'org1',
  githubRepoId: 1,
  fullName: 'acme/web',
  installation: { id: 'inst1', githubInstallationId: 7 },
};
const seedGraph = () => new CommitGraph(seedSnapshot().commits);
const req = (path: string) => new Request(`http://localhost${path}`);
const ctx = (repoId = 'r1') => ({ params: Promise.resolve({ repoId }) });
const errCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;
const cmp = (a: string, b: string, repoId = 'r1') =>
  getCompare(
    req(`/api/repos/${repoId}/tree/compare?${new URLSearchParams({ a, b })}`),
    ctx(repoId),
  );

let heads: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  redis.store.clear();
  redis.down = false;
  auth.user = 'u1';
  auth.roles = new Map([['u1:org1', 'member']]);
  heads = new Map(seedBranches.map((b) => [b.name, b.headSha]));
  db.repo.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'r1' ? repo : null,
  );
  db.user.findUnique.mockResolvedValue({ login: 'octo' });
  db.branch.findMany.mockImplementation(async ({ where }: { where: { name: { in: string[] } } }) =>
    where.name.in.filter((n) => heads.has(n)).map((name) => ({ name, headSha: heads.get(name)! })),
  );
  db.compareOverride.findMany.mockResolvedValue([]);
  db.gitEvent.findFirst.mockResolvedValue({ id: 'ev1' });
  db.pullRequest.findMany.mockResolvedValue([]);
  perm.getRepoCollaborator.mockResolvedValue(true);
  perm.getRepoPermission.mockResolvedValue('read');
  graphs.loadCommitGraph.mockImplementation(async () => seedGraph());
});

// ---------------------------------------------------------------- GET /tree/compare

describe('GET /api/repos/:repoId/tree/compare', () => {
  it('401 without a session', async () => {
    auth.user = null;
    const res = await cmp('dev', 'main');
    expect(res.status).toBe(401);
    expect(graphs.loadCommitGraph).not.toHaveBeenCalled();
  });

  it('403 for an org member who is not a collaborator; 404 for an unknown repo', async () => {
    perm.getRepoCollaborator.mockResolvedValue(false);
    expect((await cmp('dev', 'main')).status).toBe(403);
    perm.getRepoCollaborator.mockResolvedValue(true);
    expect((await cmp('dev', 'main', 'nope')).status).toBe(404);
    expect(graphs.loadCommitGraph).not.toHaveBeenCalled();
  });

  it('400 for a missing or equal pair; 404 for an unknown branch', async () => {
    const res = await getCompare(req('/api/repos/r1/tree/compare?a=dev'), ctx());
    expect(res.status).toBe(400);
    expect((await cmp('dev', 'dev')).status).toBe(400);
    const gone = await cmp('dev', 'gone');
    expect(gone.status).toBe(404);
    expect(await errCode(gone)).toBe('not_found');
  });

  it('computes ahead/behind/merge-base on the graph (a vs b)', async () => {
    const res = await cmp('feature/login', 'main');
    expect(res.status).toBe(200);
    const body = CompareResponse.parse(await res.json());
    const g = seedGraph();
    expect(body).toEqual({
      ...g.aheadBehind(SEED_SHA.f3!, heads.get('main')!),
      mergeBase: g.mergeBase(SEED_SHA.f3!, heads.get('main')!),
    });
    expect(body.ahead).toBeGreaterThan(0);
    // The graph is read for exactly these two heads.
    expect(graphs.loadCommitGraph).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', githubRepoId: 1 }),
      [SEED_SHA.f3, heads.get('main')],
    );
  });

  it('caches 60 s in Redis keyed by both head SHAs; a moved head is a new key', async () => {
    await cmp('dev', 'main');
    const key = compareCacheKey('r1', heads.get('dev')!, heads.get('main')!);
    expect(redis.set).toHaveBeenCalledWith(key, expect.any(String), 'EX', COMPARE_CACHE_SECONDS);
    expect(COMPARE_CACHE_SECONDS).toBe(60);

    // Hit: no graph read.
    graphs.loadCommitGraph.mockClear();
    const hit = CompareResponse.parse(await (await cmp('dev', 'main')).json());
    expect(graphs.loadCommitGraph).not.toHaveBeenCalled();
    expect(hit).toEqual(JSON.parse(redis.store.get(key)!.v));

    // Swapped order is another question (ahead and behind swap).
    const swapped = CompareResponse.parse(await (await cmp('main', 'dev')).json());
    expect(swapped).toMatchObject({ ahead: hit.behind, behind: hit.ahead });

    // dev moves: new key, recomputed.
    heads.set('dev', SEED_SHA.d1!);
    graphs.loadCommitGraph.mockClear();
    await cmp('dev', 'main');
    expect(graphs.loadCommitGraph).toHaveBeenCalledTimes(1);
    expect(redis.store.has(compareCacheKey('r1', SEED_SHA.d1!, heads.get('main')!))).toBe(true);
  });

  it('works without Redis (computes every time)', async () => {
    redis.down = true;
    const res = await cmp('dev', 'main');
    expect(res.status).toBe(200);
  });

  it('409 when the clone is missing or lacks a head', async () => {
    graphs.loadCommitGraph.mockResolvedValue(null);
    const res = await cmp('dev', 'main');
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('conflict');
    graphs.loadCommitGraph.mockResolvedValue(new CommitGraph(seedSnapshot().commits.slice(0, 2)));
    expect((await cmp('dev', 'main')).status).toBe(409);
  });
});

// ---------------------------------------------------------------- GET /tree?visible=

const stored = (snapshot = seedSnapshot()) => ({
  repoId: 'r1',
  status: 'ready',
  errorCode: null,
  defaultBranch: 'main',
  syncedAt: new Date('2026-11-20T10:00:00Z'),
  snapshot,
  updatedAt: new Date('2026-11-20T10:00:00Z'),
});
const lazySeed = () => {
  const s = seedSnapshot();
  return {
    ...s,
    branches: s.branches.map((b) =>
      b.isDefault ? b : { ...b, ahead: NOT_COMPUTED, behind: NOT_COMPUTED, mergeBase: null },
    ),
  };
};
const tree = (qs = '', headers: Record<string, string> = {}) =>
  getTree(new Request(`http://localhost/api/repos/r1/tree${qs}`, { headers }), ctx());

describe('GET /api/repos/:repoId/tree?visible=', () => {
  it('a full snapshot never reads a graph, with or without visible', async () => {
    db.repoGraph.findUnique.mockResolvedValue(stored());
    const res = await tree('?visible=dev&visible=feature%2Flogin');
    expect(res.status).toBe(200);
    expect(graphs.loadCommitGraph).not.toHaveBeenCalled();
    const body = GetTreeResponse.parse(await res.json());
    expect(body.snapshot?.branches.find((b) => b.name === 'dev')?.ahead).toBe(2);
  });

  it('a lazy snapshot is served as is; visible rows and their chains get counts', async () => {
    db.repoGraph.findUnique.mockResolvedValue(stored(lazySeed()));
    const plain = GetTreeResponse.parse(await (await tree()).json());
    expect(plain.snapshot?.branches.filter((b) => b.ahead === NOT_COMPUTED)).toHaveLength(5);

    const res = await tree('?visible=feature%2Flogin');
    const body = GetTreeResponse.parse(await res.json());
    const by = new Map(body.snapshot!.branches.map((b) => [b.name, b]));
    const full = new Map(seedSnapshot().branches.map((b) => [b.name, b]));
    for (const name of ['feature/login', 'dev'])
      // dev: on feature/login's compare-with chain
      expect(by.get(name)).toMatchObject({
        ahead: full.get(name)!.ahead,
        behind: full.get(name)!.behind,
        mergeBase: full.get(name)!.mergeBase,
      });
    expect(by.get('hotfix/header')!.ahead).toBe(NOT_COMPUTED);
    // compare-with is kept as stored, not re-picked.
    expect(by.get('feature/login')).toMatchObject({ compareWith: 'dev', why: 'pr' });
  });

  it('the ETag depends on the visible set; a repeat poll with the same set is a 304', async () => {
    db.repoGraph.findUnique.mockResolvedValue(stored(lazySeed()));
    const a = (await tree('?visible=dev')).headers.get('etag')!;
    const b = (await tree('?visible=hotfix%2Fheader')).headers.get('etag')!;
    const none = (await tree()).headers.get('etag')!;
    expect(new Set([a, b, none]).size).toBe(3);
    expect((await tree('?visible=dev', { 'if-none-match': a })).status).toBe(304);
  });

  it('rejects more than 200 visible names', async () => {
    db.repoGraph.findUnique.mockResolvedValue(stored());
    const qs = `?${Array.from({ length: 201 }, (_, i) => `visible=b${i}`).join('&')}`;
    expect((await tree(qs)).status).toBe(400);
  });

  it('no clone: rows stay uncomputed (no error)', async () => {
    db.repoGraph.findUnique.mockResolvedValue(stored(lazySeed()));
    graphs.loadCommitGraph.mockResolvedValue(null);
    const res = await tree('?visible=dev');
    expect(res.status).toBe(200);
    const body = GetTreeResponse.parse(await res.json());
    expect(body.snapshot!.branches.find((b) => b.name === 'dev')!.ahead).toBe(NOT_COMPUTED);
  });

  it("returns the viewer's GitHub login for the mine filter", async () => {
    db.repoGraph.findUnique.mockResolvedValue(stored());
    const body = GetTreeResponse.parse(await (await tree()).json());
    expect(body.viewerLogin).toBe('octo');
  });
});

// ---------------------------------------------------------------- T6a engine mock

describe('engine-t6a mock (T6a signatures)', () => {
  it('compare() = aheadBehind + mergeBase on head SHAs', () => {
    const g = seedGraph();
    expect(compare(g, SEED_SHA.f3!, SEED_SHA.c4!)).toEqual({
      ...g.aheadBehind(SEED_SHA.f3!, SEED_SHA.c4!),
      mergeBase: g.mergeBase(SEED_SHA.f3!, SEED_SHA.c4!),
    });
  });

  it('buildSnapshot({ visible }) computes only visible rows + chains, draws only their commits', () => {
    const repo500 = scaleRepo({ branches: 120, commits: 8000 });
    const full = scaleSnapshot(repo500);
    const pick = full.branches.filter((b) => b.compareWith && b.compareWith !== 'main')[0]!;
    const lazy = buildSnapshot({
      defaultBranch: 'main',
      branches: repo500.branches,
      graph: repo500.commits,
      prs: repo500.prs,
      maxCommitsPerBranch: 30,
      visible: [pick.name],
    });
    const kept = lazy.branches.filter((b) => b.ahead !== NOT_COMPUTED).map((b) => b.name);
    expect(kept).toContain(pick.name);
    expect(kept).toContain(pick.compareWith);
    expect(kept.length).toBeLessThan(10);
    expect(lazy.commits.length).toBeLessThan(full.commits.length / 5);
    // Compare-with is still chosen for every branch.
    expect(lazy.branches.map((b) => b.compareWith)).toEqual(
      full.branches.map((b) => b.compareWith),
    );
  });
});

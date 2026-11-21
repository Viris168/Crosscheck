import {
  ApiErrorSchema,
  GetTreeResponse,
  HttpError,
  SyncTreeResponse,
  type MemberRole,
} from '@app/shared';
import type * as GithubModule from '@app/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSnapshot } from '@/components/tree/__fixtures__/seed-snapshot';

// ---------------------------------------------------------------- mocks

const db = vi.hoisted(() => ({
  repo: { findUnique: vi.fn() },
  repoGraph: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
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

const send = vi.hoisted(() => vi.fn());
vi.mock('@/server/jobs', () => ({ inngest: { send } }));

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

beforeEach(() => {
  vi.clearAllMocks();
  redis.keys.clear();
  redis.down = false;
  auth.user = 'u1';
  auth.roles = new Map([['u1:org1', 'member']]);
  db.repo.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'r1' ? repo : null,
  );
  db.user.findUnique.mockResolvedValue({ login: 'octo' });
  db.repoGraph.findUnique.mockResolvedValue(graph);
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

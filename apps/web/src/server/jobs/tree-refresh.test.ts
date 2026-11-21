import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FixtureRepo } from '@app/git-graph/testing';
import { TreeSnapshotSchema, type CiState, type ErrorCode, type TreeSnapshot } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRunner } from './__fixtures__/fake-step';
import { cloneDir, ensureClone, readCloneGraph, type GitAuth, type RepoLock } from './repo-cache';
import {
  REFRESH_MAX_EVENTS,
  TREE_VIEWS_KEY,
  branchName,
  fetchCloneRefs,
  planRefresh,
  redisTreeRefreshState,
  refreshCursorKey,
  treeCronHandler,
  treeRefreshHandler,
  type BranchRow,
  type GitEventRow,
  type RefreshCursor,
  type RefreshRedis,
  type TreeRefreshDeps,
  type TreeRefreshState,
  type TreeRefreshStep,
  type TreeRefreshStore,
} from './tree-refresh';
import { treeSyncHandler, type ExistingPr, type TreePr, type TreeStore } from './tree-sync';

const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const NOW = new Date('2026-11-21T10:00:00Z');
const REPO = {
  id: 'repo_1',
  orgId: 'org_1',
  githubRepoId: 4242,
  fullName: 'acme/web',
  githubInstallationId: 55,
  active: true,
};

interface Row extends BranchRow {
  recordedParents: string[];
  seq: number;
}

/** In-memory DB behind both tree-sync's and tree-refresh's stores. GitEvent rows are inserted directly. */
function fakeDb() {
  let seq = 0;
  const db = {
    graph: null as null | {
      status: string;
      errorCode: ErrorCode | null;
      snapshot?: TreeSnapshot;
      syncedAt?: Date;
    },
    branches: new Map<string, Row>(),
    prs: new Map<number, ExistingPr & { headRef: string }>(),
    ci: new Map<string, { state: CiState; counts: Record<string, number> }>(),
    events: [] as GitEventRow[],
  };
  const touch = (r: Row) => (r.seq = ++seq);
  const store: TreeStore = {
    getRepo: async () => REPO,
    async setSyncing() {
      db.graph = { ...db.graph, status: 'syncing', errorCode: null };
    },
    async setFailed(_id, code) {
      db.graph = { ...db.graph, status: 'failed', errorCode: code };
    },
    existingBranches: async () => [...db.branches.values()],
    async applyBranches(_id, plan, now) {
      for (const b of plan.create)
        db.branches.set(b.name, {
          ...b,
          deletedAt: null,
          recordedParents: [],
          recordedAt: null,
          seq: ++seq,
        });
      for (const b of plan.update) {
        const r = db.branches.get(b.name)!;
        Object.assign(r, { headSha: b.headSha, isDefault: b.isDefault, deletedAt: null });
        touch(r);
      }
      for (const n of plan.softDelete) Object.assign(db.branches.get(n)!, { deletedAt: now });
    },
    existingPrs: async () => [...db.prs.values()],
    async applyPrs(_id, plan) {
      for (const p of [...plan.create, ...plan.update])
        db.prs.set(p.number, {
          number: p.number,
          state: p.state,
          headSha: p.headSha,
          headRef: p.headRef,
          baseRef: p.baseRef,
          baseSha: p.baseSha,
          mergedAt: p.mergedAt ? new Date(p.mergedAt) : null,
          mergeCommitSha: p.mergeCommitSha,
        });
    },
    liveBranches: async () =>
      [...db.branches.values()]
        .filter((b) => !b.deletedAt)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.seq - a.seq),
    terminalCiShas: async (_id, shas) =>
      new Set(
        shas.filter((s) => ['success', 'failure', 'neutral'].includes(db.ci.get(s)?.state ?? '')),
      ),
    async saveCi(_id, sha, ci) {
      db.ci.set(sha, ci);
    },
    ciStates: async (_id, shas) =>
      new Map(shas.flatMap((s) => (db.ci.has(s) ? [[s, db.ci.get(s)!.state] as const] : []))),
    prRecords: async () =>
      [...db.prs.values()].map((p) => ({
        number: p.number,
        headRef: p.headRef,
        baseRef: p.baseRef,
        state: p.state,
        headSha: p.headSha,
      })),
    overrides: async () => ({}),
    async saveSnapshot(_id, data) {
      db.graph = { status: 'ready', errorCode: null, ...data };
    },
  };

  const key = (e: { receivedAt: Date; id: string }) => `${e.receivedAt.toISOString()}|${e.id}`;
  const curKey = (c: RefreshCursor) => `${c.at}|${c.id}`;
  const refresh: TreeRefreshStore = {
    graphState: async () =>
      db.graph
        ? { syncedAt: db.graph.syncedAt ?? null, hasSnapshot: db.graph.snapshot !== undefined }
        : null,
    async gitEvents(_id, { after, since, upTo, limit }) {
      return [...db.events]
        .sort((a, b) => (key(a) < key(b) ? -1 : 1))
        .filter((e) => (after ? key(e) > curKey(after) : since ? e.receivedAt >= since : true))
        .filter((e) => (upTo ? key(e) <= curKey(upTo) : true))
        .slice(0, limit);
    },
    branchRows: async () => [...db.branches.values()],
    async applyRefresh(_id, plan, now) {
      for (const u of plan.upsert) {
        const rec = u.record
          ? { recordedParents: u.record, recordedAt: now }
          : { recordedParents: [], recordedAt: null };
        const r = db.branches.get(u.name);
        if (!r) {
          db.branches.set(u.name, {
            name: u.name,
            headSha: u.headSha,
            isDefault: false,
            deletedAt: null,
            ...rec,
            seq: ++seq,
          });
          continue;
        }
        Object.assign(r, { headSha: u.headSha, deletedAt: null });
        if (u.fresh) Object.assign(r, rec, { isDefault: false });
        else if (u.record && r.recordedAt === null) Object.assign(r, rec);
        touch(r);
      }
      for (const n of plan.remove) {
        const r = db.branches.get(n);
        if (r && !r.deletedAt) Object.assign(r, { deletedAt: now, isDefault: false });
      }
    },
    staleRepos: async () => [],
  };
  return { db, store, refresh };
}

function memoryState(): TreeRefreshState & { cursors: Map<string, RefreshCursor> } {
  const cursors = new Map<string, RefreshCursor>();
  const views = new Map<string, number>();
  return {
    cursors,
    getCursor: async (id) => cursors.get(id) ?? null,
    async setCursor(id, c) {
      cursors.set(id, c);
    },
    async recordView(id, at) {
      views.set(id, at.getTime());
    },
    viewedSince: async (since) =>
      [...views].filter(([, t]) => t >= since.getTime()).map(([id]) => id),
  };
}

function memoryLock(): RepoLock {
  const held = new Set<string>();
  return {
    async acquire(key) {
      if (held.has(key)) return null;
      held.add(key);
      return 'x';
    },
    async release(key) {
      held.delete(key);
    },
  };
}

function cloneRef(gitDir: string, name: string): string | null {
  const r = spawnSync(
    'git',
    ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`],
    {
      env: { ...process.env, ...ISOLATED },
      encoding: 'utf8',
    },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

const refreshEvent = { data: { repoId: REPO.id, orgId: REPO.orgId, eventId: 'evt' } };
const asRefreshStep = (s: unknown) => s as TreeRefreshStep;

describe('tree-refresh against a local fixture repo', () => {
  let repo: FixtureRepo;
  let cacheDir: string;
  let gitDir: string;
  let fake: ReturnType<typeof fakeDb>;
  let state: ReturnType<typeof memoryState>;
  let deps: TreeRefreshDeps;
  let prs: TreePr[];
  let n: number;
  const calls = {
    listBranches: 0,
    listPrs: 0,
    ensureClone: 0,
    fetchRefs: [] as { fetch: readonly string[]; remove: readonly string[] }[],
    ci: [] as string[],
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  /** Insert a GitEvent row the way T5a will (until T5a is merged). */
  const insert = (e: Partial<GitEventRow> & Pick<GitEventRow, 'kind'>) => {
    n++;
    fake.db.events.push({
      id: `evt_${String(n).padStart(4, '0')}`,
      ref: null,
      before: null,
      after: null,
      prNumber: null,
      receivedAt: new Date(NOW.getTime() + n * 50),
      ...e,
    });
  };
  const refresh = async () => {
    const runner = createFakeRunner();
    const result = await treeRefreshHandler(
      { event: refreshEvent, step: asRefreshStep(runner.step) },
      deps,
    );
    return { result, runner };
  };
  const snapshot = () => TreeSnapshotSchema.parse(fake.db.graph?.snapshot);
  const node = (name: string) => snapshot().branches.find((b) => b.name === name);

  beforeEach(async () => {
    repo = FixtureRepo.create('t5b-refresh');
    repo.run('config', 'uploadpack.allowFilter', 'true');
    repo.commit('one');
    repo.commit('two');
    repo.branch('feat-a');
    repo.commit('a1');
    repo.checkout('main');
    repo.commit('three');
    repo.branch('feat-b');
    repo.commit('b1');
    repo.checkout('main');
    cacheDir = mkdtempSync(path.join(tmpdir(), 't5b-refresh-'));
    gitDir = cloneDir(cacheDir, REPO.githubRepoId);
    fake = fakeDb();
    state = memoryState();
    prs = [];
    n = 0;
    calls.listBranches = 0;
    calls.listPrs = 0;
    calls.ensureClone = 0;
    calls.fetchRefs = [];
    calls.ci = [];
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    const auth: GitAuth = { url: repo.url, env: ISOLATED };
    const lock = memoryLock();
    deps = {
      sync: {
        store: fake.store,
        github: {
          async listBranches() {
            calls.listBranches++;
            return {
              defaultBranch: 'main',
              branches: repo.branches().map((name) => ({ name, headSha: repo.head(name) })),
            };
          },
          async listPullRequests() {
            calls.listPrs++;
            return prs;
          },
          async fetchCiState(_r, sha) {
            calls.ci.push(sha);
            return { state: 'success', counts: { success: 1 } };
          },
          gitAuth: async () => auth,
        },
        cache: {
          ensureClone: (r, a) => {
            calls.ensureClone++;
            return ensureClone(r, a, { cacheDir, lock, assertNoContents: true });
          },
          readGraph: (r, heads) => readCloneGraph(r, heads, { cacheDir, lock }),
        },
        merged: {
          detect: async () => new Map(),
          readCache: async () => new Map(),
          writeCache: async () => {},
        },
        now: () => NOW,
        log,
      },
      store: fake.refresh,
      state,
      refs: {
        fetchRefs: (r, a, refs) => {
          calls.fetchRefs.push(refs);
          return fetchCloneRefs(r, a, refs, { cacheDir, lock, assertNoContents: true });
        },
      },
    };
    // Start from a full sync, like a repo whose tree page was opened once.
    const sync = await treeSyncHandler(
      {
        event: { data: { repoId: REPO.id, orgId: REPO.orgId, reason: 'first_view' } },
        step: createFakeRunner().step,
      },
      deps.sync,
    );
    expect(sync.status).toBe('ready');
    calls.listBranches = 0;
    calls.listPrs = 0;
    calls.ensureClone = 0;
    calls.ci = [];
  });

  afterEach(() => {
    repo.remove();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('push → only that branch is refetched; the others stay as they were', async () => {
    const oldB = repo.head('feat-b');
    repo.checkout('feat-a');
    const a2 = repo.commit('a2');
    repo.checkout('feat-b');
    repo.commit('b2'); // moved on GitHub too, but no event for it yet
    insert({ kind: 'push', ref: 'refs/heads/feat-a', after: a2 });

    const { result, runner } = await refresh();

    expect(result).toMatchObject({ status: 'ready', events: 1 });
    expect(calls.fetchRefs).toEqual([{ fetch: ['feat-a'], remove: [] }]);
    expect(calls.listBranches).toBe(0);
    expect(calls.ensureClone).toBe(0);
    expect(cloneRef(gitDir, 'feat-a')).toBe(a2);
    expect(cloneRef(gitDir, 'feat-b')).toBe(oldB);
    expect(fake.db.branches.get('feat-a')?.headSha).toBe(a2);
    expect(fake.db.branches.get('feat-b')?.headSha).toBe(oldB);
    expect(node('feat-a')).toMatchObject({ headSha: a2, ahead: 2 });
    expect(calls.ci).toEqual([a2]); // CI only for the moved head
    expect([...runner.calls.keys()]).toEqual([
      'apply-events',
      'fetch-refs',
      'ci',
      'merged',
      'snapshot',
      'advance-cursor',
    ]);
    // the cache still holds commits only, and origin is not a promisor remote
    expect(
      execFileSync('git', ['--git-dir', gitDir, 'config', 'remote.origin.promisor'], {
        env: { ...process.env, ...ISOLATED },
        encoding: 'utf8',
      }).trim(),
    ).toBe('false');
  });

  it('step outputs hold ids, counts and SHAs only (no branch names)', async () => {
    repo.checkout('feat-a');
    insert({ kind: 'push', ref: 'refs/heads/feat-a', after: repo.commit('a2') });
    insert({ kind: 'branch_created', ref: 'refs/heads/secret-launch', after: repo.head('main') });
    const { runner } = await refresh();
    const out = JSON.stringify([...runner.outputs.values()]);
    expect(out).not.toMatch(/feat-a|feat-b|secret-launch|main|acme/);
  });

  it('delete → the ref is removed from the clone and the row soft-deleted', async () => {
    repo.run('branch', '-D', 'feat-b');
    insert({ kind: 'branch_deleted', ref: 'refs/heads/feat-b' });

    const { result } = await refresh();

    expect(result.status).toBe('ready');
    expect(calls.fetchRefs).toEqual([{ fetch: [], remove: ['feat-b'] }]);
    expect(cloneRef(gitDir, 'feat-b')).toBeNull();
    expect(fake.db.branches.get('feat-b')?.deletedAt).toEqual(NOW);
    expect(node('feat-b')).toBeUndefined();
  });

  it('create from feat-a → recordedParents = [feat-a], shown as recorded', async () => {
    const at = repo.head('feat-a');
    repo.branch('feat-c', at);
    insert({ kind: 'branch_created', ref: 'refs/heads/feat-c', before: '0'.repeat(40), after: at });

    await refresh();

    expect(fake.db.branches.get('feat-c')).toMatchObject({
      headSha: at,
      recordedParents: ['feat-a'],
      recordedAt: NOW,
    });
    expect(cloneRef(gitDir, 'feat-c')).toBe(at);
    expect(node('feat-c')).toMatchObject({
      compareWith: 'feat-a',
      why: 'recorded',
      ambiguous: null,
      recorded: true,
    });
  });

  it('two branches at one commit → both recorded (ambiguous)', async () => {
    const at = repo.head('feat-a');
    repo.branch('feat-a2', at);
    repo.branch('feat-c', at);
    insert({ kind: 'branch_created', ref: 'refs/heads/feat-a2', after: at });
    insert({ kind: 'branch_created', ref: 'refs/heads/feat-c', after: at });

    await refresh();

    expect(fake.db.branches.get('feat-a2')?.recordedParents).toEqual(['feat-a']);
    expect(fake.db.branches.get('feat-c')?.recordedParents).toEqual(['feat-a', 'feat-a2']);
    expect(node('feat-c')).toMatchObject({ why: 'recorded', ambiguous: 2, recorded: true });
  });

  it('a branch pushed with new commits records nothing and is not shown as recorded', async () => {
    repo.branch('feat-new', repo.head('main'));
    const sha = repo.commit('brand new');
    insert({ kind: 'branch_created', ref: 'refs/heads/feat-new', after: sha });

    await refresh();

    expect(fake.db.branches.get('feat-new')).toMatchObject({
      recordedParents: [],
      recordedAt: NOW,
    });
    expect(node('feat-new')).toMatchObject({ why: 'inferred', recorded: false });
  });

  it('10 events in 1 s → one refresh that applies all of them', async () => {
    repo.checkout('feat-a');
    let last = '';
    for (let i = 0; i < 10; i++) {
      last = repo.commit(`burst ${i}`);
      insert({ kind: 'push', ref: 'refs/heads/feat-a', after: last });
    }

    const { result, runner } = await refresh();

    expect(result).toMatchObject({ status: 'ready', events: 10 });
    expect(calls.fetchRefs).toHaveLength(1);
    expect(runner.calls.get('snapshot')).toBe(1);
    expect(node('feat-a')?.headSha).toBe(last);
    // the debounced duplicates that still arrive find nothing new
    expect((await refresh()).result).toEqual({ status: 'skipped', reason: 'no_events' });
  });

  it('CI-only events skip the fetch and re-read CI for that head', async () => {
    const head = repo.head('main');
    expect(fake.db.ci.get(head)?.state).toBe('success'); // terminal, cached
    insert({ kind: 'ci', ref: 'refs/heads/main', after: head });

    const { result, runner } = await refresh();

    expect(result.status).toBe('ready');
    expect(calls.fetchRefs).toEqual([]);
    expect(runner.calls.has('fetch-refs')).toBe(false);
    expect(calls.ci).toEqual([head]);
  });

  it('a pull_request event re-reads PRs', async () => {
    prs = [
      {
        number: 7,
        state: 'open',
        headRef: 'feat-b',
        headSha: repo.head('feat-b'),
        baseRef: 'feat-a',
        baseSha: null,
        mergedAt: null,
        mergeCommitSha: null,
        title: 't',
        author: 'a',
        updatedAt: NOW.toISOString(),
      },
    ];
    insert({ kind: 'pull_request', prNumber: 7 });

    await refresh();

    expect(calls.listPrs).toBe(1);
    expect(calls.fetchRefs).toEqual([]);
    expect(node('feat-b')).toMatchObject({ compareWith: 'feat-a', why: 'pr', whyPr: 7 });
  });

  it('a force-push on the default branch falls back to the full sync', async () => {
    insert({ kind: 'force_push', ref: 'refs/heads/main', after: repo.head('main') });

    const { result, runner } = await refresh();

    expect(result).toEqual({ status: 'full_sync', events: 1, reason: 'default_force_push' });
    expect(runner.sent).toEqual([
      {
        id: 'request-full-sync',
        payload: {
          name: 'tree/sync-requested',
          data: { repoId: REPO.id, orgId: REPO.orgId, reason: 'webhook' },
        },
      },
    ]);
    expect(calls.fetchRefs).toEqual([]);
    expect(state.cursors.get(REPO.id)?.id).toBe('evt_0001');
  });

  it('a force-push on another branch is just a ref fetch', async () => {
    repo.checkout('feat-a');
    repo.run('reset', '-q', '--hard', 'HEAD~1');
    const rewritten = repo.commit('a1 rewritten');
    insert({ kind: 'force_push', ref: 'refs/heads/feat-a', after: rewritten });

    const { result } = await refresh();

    expect(result.status).toBe('ready');
    expect(cloneRef(gitDir, 'feat-a')).toBe(rewritten);
    expect(node('feat-a')?.headSha).toBe(rewritten);
  });

  it('a ref that is gone on GitHub falls back to a full fetch', async () => {
    insert({ kind: 'push', ref: 'refs/heads/vanished', after: repo.head('main') });

    const { result } = await refresh();

    expect(result.status).toBe('ready');
    expect(calls.ensureClone).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'tree-refresh: ref fetch failed, fetching all',
    );
  });

  it('only reads events after the cursor', async () => {
    repo.checkout('feat-a');
    insert({ kind: 'push', ref: 'refs/heads/feat-a', after: repo.commit('a2') });
    await refresh();
    const a3 = repo.commit('a3');
    insert({ kind: 'push', ref: 'refs/heads/feat-a', after: a3 });

    const { result } = await refresh();

    expect(result).toMatchObject({ status: 'ready', events: 1 });
    expect(state.cursors.get(REPO.id)).toEqual({
      at: fake.db.events[1]!.receivedAt.toISOString(),
      id: 'evt_0002',
    });
  });

  it('a failure hands the repo to the full sync and keeps what was applied', async () => {
    deps.sync.cache.readGraph = async () => {
      throw new Error('[internal] boom');
    };
    const at = repo.head('feat-a');
    repo.branch('feat-c', at);
    insert({ kind: 'branch_created', ref: 'refs/heads/feat-c', after: at });

    const { result, runner } = await refresh();

    expect(result).toEqual({ status: 'full_sync', events: 1, reason: 'error' });
    expect(runner.sent.map((s) => (s.payload as { name: string }).name)).toEqual([
      'tree/sync-requested',
    ]);
    expect(fake.db.branches.get('feat-c')?.recordedParents).toEqual(['feat-a']);
    expect(state.cursors.get(REPO.id)?.id).toBe('evt_0001');
  });

  it('no snapshot yet → full sync instead of a refresh', async () => {
    fake.db.graph = null;
    insert({ kind: 'push', ref: 'refs/heads/feat-a', after: repo.head('feat-a') });

    const { result } = await refresh();

    expect(result).toEqual({ status: 'full_sync', events: 1, reason: 'no_snapshot' });
    expect(calls.fetchRefs).toEqual([]);
  });

  it(`more than ${REFRESH_MAX_EVENTS} events → continues with another tree/refs-changed`, async () => {
    const head = repo.head('main');
    for (let i = 0; i < REFRESH_MAX_EVENTS + 1; i++) insert({ kind: 'ci', after: head });

    const { result, runner } = await refresh();

    expect(result).toMatchObject({ status: 'ready', events: REFRESH_MAX_EVENTS });
    expect(runner.sent).toEqual([
      {
        id: 'continue',
        payload: {
          name: 'tree/refs-changed',
          data: { repoId: REPO.id, orgId: REPO.orgId, eventId: `evt_${REFRESH_MAX_EVENTS}` },
        },
      },
    ]);
    expect((await refresh()).result).toMatchObject({ status: 'ready', events: 1 });
  });
});

describe('planRefresh', () => {
  const sha = (c: string) => c.repeat(40);
  const row = (name: string, head: string, over: Partial<BranchRow> = {}): BranchRow => ({
    name,
    headSha: head,
    isDefault: name === 'main',
    deletedAt: null,
    recordedAt: null,
    ...over,
  });
  let i = 0;
  const ev = (e: Partial<GitEventRow> & Pick<GitEventRow, 'kind'>): GitEventRow => ({
    id: `e${++i}`,
    ref: null,
    before: null,
    after: null,
    prNumber: null,
    receivedAt: NOW,
    ...e,
  });

  it('never overwrites a recording', () => {
    const plan = planRefresh(
      [row('main', sha('a')), row('feat', sha('a'), { recordedAt: NOW })],
      [ev({ kind: 'branch_created', ref: 'feat', after: sha('a') })],
    );
    expect(plan.upsert).toEqual([{ name: 'feat', headSha: sha('a'), fresh: false, record: null }]);
  });

  it('a branch deleted and created again in one batch is new: recorded afresh', () => {
    const plan = planRefresh(
      [row('main', sha('a')), row('dev', sha('b')), row('feat', sha('c'), { recordedAt: NOW })],
      [
        ev({ kind: 'branch_deleted', ref: 'refs/heads/feat' }),
        ev({ kind: 'branch_created', ref: 'refs/heads/feat', after: sha('b') }),
      ],
    );
    expect(plan.remove).toEqual([]);
    expect(plan.upsert).toEqual([
      { name: 'feat', headSha: sha('b'), fresh: true, record: ['dev'] },
    ]);
  });

  it('records from the heads at that moment, not the final ones', () => {
    const plan = planRefresh(
      [row('main', sha('a')), row('dev', sha('b'))],
      [
        ev({ kind: 'push', ref: 'dev', after: sha('c') }),
        ev({ kind: 'branch_created', ref: 'x', after: sha('b') }),
        ev({ kind: 'branch_created', ref: 'y', after: sha('c') }),
      ],
    );
    const by = new Map(plan.upsert.map((u) => [u.name, u.record]));
    expect(by.get('x')).toEqual([]);
    expect(by.get('y')).toEqual(['dev']);
  });

  it('ignores tags, bad SHAs and unknown kinds; flags PR and default force-push', () => {
    const plan = planRefresh(
      [row('main', sha('a'))],
      [
        ev({ kind: 'push', ref: 'refs/tags/v1', after: sha('b') }),
        ev({ kind: 'push', ref: 'feat', after: 'not-a-sha' }),
        ev({ kind: 'push', ref: '--upload-pack=x', after: sha('b') }),
        ev({ kind: 'weird', ref: 'feat', after: sha('b') }),
        ev({ kind: 'pull_request', prNumber: 3 }),
        ev({ kind: 'force_push', ref: 'refs/heads/main', after: sha('d') }),
      ],
    );
    expect(plan.skipped).toBe(4);
    expect(plan.prs).toBe(true);
    expect(plan.fullSync).toBe(true);
    expect(plan.upsert.map((u) => u.name)).toEqual(['main']);
  });

  it('branchName strips refs/heads/ and rejects unsafe names', () => {
    expect(branchName('refs/heads/feature/login')).toBe('feature/login');
    expect(branchName('feature/login')).toBe('feature/login');
    expect(branchName('refs/tags/v1')).toBeNull();
    expect(branchName('refs/pull/1/head')).toBeNull();
    for (const bad of ['-x', 'a..b', 'a b', 'a:b', 'x.lock', '.hidden', 'a//b', 'a@{1}', null])
      expect(branchName(bad)).toBeNull();
  });
});

describe('tree-cron', () => {
  it('picks only stale repos viewed in the last 7 days', async () => {
    const day = 24 * 60 * 60_000;
    const state = memoryState();
    await state.recordView('viewed_stale', new Date(NOW.getTime() - day));
    await state.recordView('viewed_fresh', new Date(NOW.getTime() - day));
    await state.recordView('viewed_long_ago', new Date(NOW.getTime() - 8 * day));
    const graphs: Record<string, Date | null> = {
      viewed_stale: new Date(NOW.getTime() - 16 * 60_000),
      viewed_fresh: new Date(NOW.getTime() - 5 * 60_000),
      viewed_long_ago: new Date(NOW.getTime() - day),
      never_viewed: new Date(NOW.getTime() - day),
    };
    const store = {
      async staleRepos(ids: readonly string[], cutoff: Date) {
        return ids
          .filter((id) => id in graphs && (graphs[id] === null || graphs[id]! < cutoff))
          .map((repoId) => ({ repoId, orgId: 'org_1' }));
      },
    } as unknown as TreeRefreshStore;
    const runner = createFakeRunner();

    const out = await treeCronHandler(
      { step: asRefreshStep(runner.step) },
      { store, state, now: () => NOW, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );

    expect(out).toEqual({ requested: 1 });
    expect(runner.sent).toEqual([
      {
        id: 'request-syncs',
        payload: [
          {
            name: 'tree/sync-requested',
            data: { repoId: 'viewed_stale', orgId: 'org_1', reason: 'cron' },
          },
        ],
      },
    ]);
  });

  it('sends nothing when no repo was viewed', async () => {
    const runner = createFakeRunner();
    const store = { staleRepos: vi.fn() } as unknown as TreeRefreshStore;
    const out = await treeCronHandler(
      { step: asRefreshStep(runner.step) },
      {
        store,
        state: memoryState(),
        now: () => NOW,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    );
    expect(out).toEqual({ requested: 0 });
    expect(runner.sent).toEqual([]);
  });
});

describe('redisTreeRefreshState', () => {
  function fakeRedis() {
    const kv = new Map<string, string>();
    const z = new Map<string, number>();
    const num = (v: number | string, open = false) =>
      v === '-inf' ? -Infinity : v === '+inf' ? Infinity : open ? Number(String(v).slice(1)) : +v;
    const redis: RefreshRedis & { kv: typeof kv; z: typeof z; ttl?: number } = {
      kv,
      z,
      get: async (k) => kv.get(k) ?? null,
      async set(k, v, _ex, s) {
        kv.set(k, v);
        redis.ttl = s;
        return 'OK';
      },
      async zadd(_k, score, m) {
        z.set(m, score);
        return 1;
      },
      async zremrangebyscore(_k, min, max) {
        const exclusive = String(max).startsWith('(');
        const hi = num(max, exclusive);
        for (const [m, s] of z) if (s >= num(min) && (exclusive ? s < hi : s <= hi)) z.delete(m);
        return 1;
      },
      zrangebyscore: async (_k, min, max) =>
        [...z].filter(([, s]) => s >= num(min) && s <= num(max)).map(([m]) => m),
    };
    return redis;
  }

  it('round-trips the cursor with a TTL and ignores junk', async () => {
    const redis = fakeRedis();
    const s = redisTreeRefreshState(redis);
    expect(await s.getCursor('r')).toBeNull();
    await s.setCursor('r', { at: NOW.toISOString(), id: 'evt_1' });
    expect(await s.getCursor('r')).toEqual({ at: NOW.toISOString(), id: 'evt_1' });
    expect(redis.ttl).toBe(30 * 24 * 60 * 60);
    redis.kv.set(refreshCursorKey('r'), 'not json');
    expect(await s.getCursor('r')).toBeNull();
  });

  it('keeps views in one sorted set and drops old ones', async () => {
    const redis = fakeRedis();
    const s = redisTreeRefreshState(redis);
    await s.recordView('old', new Date(1000));
    await s.recordView('new', new Date(5000));
    expect(await s.viewedSince(new Date(2000))).toEqual(['new']);
    expect([...redis.z.keys()]).toEqual(['new']);
    expect(TREE_VIEWS_KEY).toBe('tree:views');
  });
});

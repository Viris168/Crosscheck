import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FixtureRepo } from '@app/git-graph/testing';
import { TreeSnapshotSchema, type CiState, type ErrorCode, type TreeSnapshot } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRunner } from './__fixtures__/fake-step';
import {
  RepoBusyError,
  assertNoContents,
  cloneDir,
  ensureClone,
  loadCloneGraph,
  readCloneGraph,
  saveCloneGraph,
  type GitAuth,
  type RepoLock,
} from './repo-cache';
import {
  CI_MAX_PER_RUN,
  MERGED_CACHE_TTL_S,
  applyContentMerged,
  mergedCacheField,
  planBranches,
  planPrs,
  treeSyncHandler,
  type ExistingPr,
  type TreePr,
  type MergedDetectInput,
  type MergedOutcome,
  type TreeMerged,
  type TreeStore,
  type TreeSyncDeps,
  redisTreeMerged,
} from './tree-sync';

const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const NOW = new Date('2026-11-21T10:00:00Z');
const REPO = {
  id: 'repo_1',
  orgId: 'org_1',
  githubRepoId: 777,
  fullName: 'acme/web',
  githubInstallationId: 55,
  active: true,
};

interface BranchRow {
  name: string;
  headSha: string;
  isDefault: boolean;
  deletedAt: Date | null;
  recordedParents: string[];
  recordedAt: Date | null;
  seq: number;
}

function fakeStore() {
  let seq = 0;
  const db = {
    repo: { ...REPO } as typeof REPO | null,
    graph: null as null | {
      status: string;
      errorCode: ErrorCode | null;
      defaultBranch?: string;
      snapshot?: TreeSnapshot;
      syncedAt?: Date;
    },
    branches: new Map<string, BranchRow>(),
    prs: new Map<number, ExistingPr & { title: string; author: string; headRef: string }>(),
    ci: new Map<string, { state: CiState; counts: Record<string, number> }>(),
    overrides: {} as Record<string, string>,
  };
  const store: TreeStore = {
    async getRepo() {
      return db.repo;
    },
    async setSyncing() {
      db.graph = { ...db.graph, status: 'syncing', errorCode: null };
    },
    async setFailed(_id, code) {
      db.graph = { ...db.graph, status: 'failed', errorCode: code };
    },
    async existingBranches() {
      return [...db.branches.values()];
    },
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
        const row = db.branches.get(b.name)!;
        Object.assign(row, {
          headSha: b.headSha,
          isDefault: b.isDefault,
          deletedAt: null,
          seq: ++seq,
        });
      }
      for (const n of plan.softDelete) Object.assign(db.branches.get(n)!, { deletedAt: now });
    },
    async existingPrs() {
      return [...db.prs.values()];
    },
    async applyPrs(_id, plan) {
      for (const p of [...plan.create, ...plan.update]) {
        db.prs.set(p.number, {
          number: p.number,
          state: p.state,
          headSha: p.headSha,
          baseRef: p.baseRef,
          baseSha: p.baseSha,
          mergedAt: p.mergedAt ? new Date(p.mergedAt) : null,
          mergeCommitSha: p.mergeCommitSha,
          title: p.title,
          author: p.author,
          headRef: p.headRef,
        });
      }
    },
    async liveBranches() {
      return [...db.branches.values()]
        .filter((b) => !b.deletedAt)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.seq - a.seq);
    },
    async terminalCiShas(_id, shas) {
      return new Set(
        shas.filter((s) => ['success', 'failure', 'neutral'].includes(db.ci.get(s)?.state ?? '')),
      );
    },
    async saveCi(_id, sha, ci) {
      db.ci.set(sha, ci);
    },
    async ciStates(_id, shas) {
      return new Map(shas.flatMap((s) => (db.ci.has(s) ? [[s, db.ci.get(s)!.state]] : [])));
    },
    async prRecords() {
      return [...db.prs.values()].map((p) => ({
        number: p.number,
        headRef: p.headRef,
        baseRef: p.baseRef,
        state: p.state,
        headSha: p.headSha,
      }));
    },
    async overrides() {
      return db.overrides;
    },
    async saveSnapshot(_id, data) {
      db.graph = { status: 'ready', errorCode: null, ...data };
    },
  };
  return { db, store };
}

function memoryLock(): RepoLock {
  const held = new Map<string, string>();
  return {
    async acquire(key) {
      if (held.has(key)) return null;
      held.set(key, 'x');
      return 'x';
    },
    async release(key) {
      held.delete(key);
    },
  };
}

function pr(over: Partial<TreePr> & Pick<TreePr, 'number' | 'headRef' | 'headSha'>): TreePr {
  return {
    state: 'open',
    baseRef: 'main',
    baseSha: '0'.repeat(40),
    mergedAt: null,
    mergeCommitSha: null,
    title: 'Secret title: launch plans',
    author: 'octo',
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** In-memory merged cache + a scripted detector (stands in for T3a's workspace). */
function fakeMerged() {
  const state = {
    hash: new Map<string, string>(),
    detectCalls: [] as MergedDetectInput[],
    answer: new Map<string, MergedOutcome>(),
    fail: null as Error | null,
  };
  const merged: TreeMerged = {
    async detect(_repo, _auth, input) {
      state.detectCalls.push(input);
      if (state.fail) throw state.fail;
      return new Map(
        input.branches.flatMap((b) =>
          state.answer.has(b.name) ? [[b.name, state.answer.get(b.name)!] as const] : [],
        ),
      );
    },
    async readCache() {
      return new Map(state.hash);
    },
    async writeCache(_id, entries) {
      state.hash = new Map(entries);
    },
  };
  return { state, merged };
}

const event = { data: { repoId: REPO.id, orgId: REPO.orgId, reason: 'manual' as const } };

describe('tree-sync against a local fixture repo', () => {
  let repo: FixtureRepo;
  let cacheDir: string;
  let fake: ReturnType<typeof fakeStore>;
  let deps: TreeSyncDeps;
  let auth: GitAuth;
  let ciCalls: string[];
  let ciAnswer: CiState;
  let prs: TreePr[];
  let fm: ReturnType<typeof fakeMerged>;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    repo = FixtureRepo.create('t2c-sync');
    repo.run('config', 'uploadpack.allowFilter', 'true');
    repo.commit('one');
    repo.commit('two');
    repo.branch('feature/login');
    repo.commit('login form');
    repo.checkout('main');
    repo.commit('three');
    cacheDir = mkdtempSync(path.join(tmpdir(), 't2c-sync-'));
    auth = { url: repo.url, env: ISOLATED };
    fake = fakeStore();
    fm = fakeMerged();
    ciCalls = [];
    ciAnswer = 'success';
    prs = [pr({ number: 1, headRef: 'feature/login', headSha: repo.head('feature/login') })];
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    const lock = memoryLock();
    deps = {
      store: fake.store,
      github: {
        async listBranches() {
          return {
            defaultBranch: 'main',
            branches: repo.branches().map((name) => ({ name, headSha: repo.head(name) })),
          };
        },
        async listPullRequests() {
          return prs;
        },
        async fetchCiState(_r, sha) {
          ciCalls.push(sha);
          return { state: ciAnswer, counts: { [ciAnswer]: 1 } };
        },
        async gitAuth() {
          return auth;
        },
      },
      cache: {
        ensureClone: (r, a) => ensureClone(r, a, { cacheDir, lock, assertNoContents: true }),
        readGraph: (r, heads) => readCloneGraph(r, heads, { cacheDir, lock }),
        saveGraph: (r, heads, graph) => saveCloneGraph(r, heads, graph, { cacheDir }),
      },
      merged: fm.merged,
      now: () => NOW,
      log,
    };
  });

  afterEach(() => {
    repo.remove();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('syncs refs, PRs, CI and the clone, then writes a valid ready snapshot', async () => {
    const runner = createFakeRunner();
    const result = await treeSyncHandler({ event, step: runner.step }, deps);

    expect(result).toEqual({ status: 'ready', branches: 2, commits: 4, truncated: false });
    expect([...runner.calls.keys()]).toEqual(['load-refs', 'fetch', 'ci', 'merged', 'snapshot']);
    expect(fake.db.graph?.status).toBe('ready');
    expect(fake.db.graph?.defaultBranch).toBe('main');
    expect(fake.db.graph?.syncedAt).toEqual(NOW);
    const snap = TreeSnapshotSchema.parse(fake.db.graph?.snapshot);
    const login = snap.branches.find((b) => b.name === 'feature/login')!;
    expect(login).toMatchObject({
      compareWith: 'main',
      why: 'pr',
      whyPr: 1,
      ahead: 1,
      behind: 1,
      ci: 'success',
      pr: { number: 1, state: 'open', baseRef: 'main' },
    });
    expect(fake.db.prs.get(1)).toMatchObject({ state: 'open', headRef: 'feature/login' });
    expect(ciCalls.sort()).toEqual([repo.head('feature/login'), repo.head('main')].sort());
    await assertNoContents(cloneDir(cacheDir, REPO.githubRepoId));
  });

  it('stores the graph for the API; a refresh that moves any branch invalidates it', async () => {
    const heads = () => repo.branches().map((name) => ({ name, headSha: repo.head(name) }));
    const load = (h: { name: string; headSha: string }[]) => loadCloneGraph(REPO, h, { cacheDir });
    await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    const before = heads();
    const graph = await load(before);
    expect(graph?.compare(repo.head('feature/login'), repo.head('main'))).toMatchObject({
      ahead: 1,
      behind: 1,
    });

    repo.commit('four');
    // GitHub moved, the sync has not run: the old file does not answer for the new heads.
    expect(await load(heads())).toBeNull();
    await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    expect((await load(heads()))?.has(repo.head('main'))).toBe(true);
    expect(await load(before)).toBeNull();
    // Ids only next to the clone: the file never names a branch.
    const file = readFileSync(path.join(cacheDir, `${REPO.githubRepoId}.graph`), 'latin1');
    expect(file).not.toContain('feature/login');
  });

  it('a failed graph cache write never fails the sync', async () => {
    deps.cache.saveGraph = async () => {
      throw new Error('ENOSPC');
    };
    const result = await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    expect(result.status).toBe('ready');
    expect(log.warn).toHaveBeenCalledWith(
      { repoId: REPO.id, reason: 'graph_cache_failed' },
      expect.any(String),
    );
  });

  it('step outputs hold only counts and flags (Inngest persists them)', async () => {
    repo.branch('fix/squashed', 'main');
    repo.commit('squashed elsewhere');
    repo.checkout('main');
    fm.state.answer.set('fix/squashed', 'squashed');
    const runner = createFakeRunner();
    await treeSyncHandler({ event, step: runner.step }, deps);
    const outputs = Object.fromEntries(runner.outputs);
    expect(outputs).toMatchInlineSnapshot(`
      {
        "ci": {
          "cached": 0,
          "deferred": 0,
          "fetched": 3,
          "heads": 3,
        },
        "fetch": {
          "ok": true,
        },
        "load-refs": {
          "branches": 3,
          "branchesCreated": 3,
          "branchesDeleted": 0,
          "branchesUpdated": 0,
          "prs": 1,
          "prsCreated": 1,
          "prsUpdated": 0,
          "skipped": false,
        },
        "merged": {
          "byVia": {
            "pr": 0,
            "rebased": 0,
            "squashed": 1,
          },
          "checked": 2,
          "merged": 1,
        },
        "snapshot": {
          "branches": 3,
          "commits": 5,
          "skippedBranches": 0,
          "truncated": false,
        },
      }
    `);
    const strings: unknown[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(outputs);
    expect(strings).toEqual([]); // no string values at all: no names, SHAs or titles
  });

  it('second run: soft-deletes gone branches, follows a force-push, keeps terminal CI cached', async () => {
    await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    ciCalls = [];

    repo.run('branch', '-D', 'feature/login');
    repo.branch('fix/typo', 'main~1');
    repo.commit('typo');
    repo.checkout('main');
    repo.run('reset', '-q', '--hard', 'main~1'); // force-push main back
    repo.commit('three again');
    prs = [
      pr({
        number: 1,
        headRef: 'feature/login',
        headSha: prs[0]!.headSha,
        state: 'merged',
        mergedAt: NOW.toISOString(),
        mergeCommitSha: repo.head('main'),
      }),
    ];

    const runner = createFakeRunner();
    const result = await treeSyncHandler({ event, step: runner.step }, deps);
    expect(result).toMatchObject({ status: 'ready', branches: 2 });
    expect(runner.outputs.get('load-refs')).toMatchObject({
      branchesCreated: 1,
      branchesUpdated: 1,
      branchesDeleted: 1,
      prsUpdated: 1,
    });
    expect(fake.db.branches.get('feature/login')?.deletedAt).toEqual(NOW);
    expect(fake.db.prs.get(1)).toMatchObject({ state: 'merged', mergedAt: NOW });
    const snap = fake.db.graph!.snapshot!;
    expect(snap.branches.map((b) => b.name).sort()).toEqual(['fix/typo', 'main']);
    expect(snap.branches.find((b) => b.isDefault)?.headSha).toBe(repo.head('main'));
    // only the two new heads were fetched; nothing cached was asked again
    expect(ciCalls.sort()).toEqual([repo.head('fix/typo'), repo.head('main')].sort());
    await assertNoContents(cloneDir(cacheDir, REPO.githubRepoId));
  });

  it('re-fetches CI that is still pending', async () => {
    ciAnswer = 'pending';
    await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    ciCalls = [];
    ciAnswer = 'failure';
    await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    expect(ciCalls).toHaveLength(2);
    expect(fake.db.graph?.snapshot?.branches.every((b) => b.ci === 'failure')).toBe(true);
  });

  it('a failing fetch marks the repo failed and logs no token', async () => {
    await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
    const token = 'ghs_t2cSecretToken123';
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    // fetch.prune gets the header as its value so git prints it in stderr ("bad boolean config value '…'")
    auth = {
      url: `file://${cacheDir}/gone`,
      env: {
        ...ISOLATED,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: header,
        GIT_CONFIG_KEY_1: 'fetch.prune',
        GIT_CONFIG_VALUE_1: header,
      },
    };
    const runner = createFakeRunner({ retries: 0 });
    const result = await treeSyncHandler({ event, step: runner.step }, deps);

    expect(result).toEqual({ status: 'failed', errorCode: 'github_error' });
    expect(fake.db.graph).toMatchObject({ status: 'failed', errorCode: 'github_error' });
    expect(fake.db.graph?.snapshot).toBeDefined(); // last good snapshot kept
    expect(log.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).toMatch(/git fetch failed/);
    for (const bad of [/x-access-token/i, /AUTHORIZATION/i, /ghs_/, new RegExp(token)]) {
      expect(logged).not.toMatch(bad);
      expect(JSON.stringify(Object.fromEntries(runner.outputs))).not.toMatch(bad);
    }
  });

  it('skips a missing or inactive repo without touching anything', async () => {
    fake.db.repo = { ...REPO, active: false };
    const runner = createFakeRunner();
    expect(await treeSyncHandler({ event, step: runner.step }, deps)).toEqual({
      status: 'skipped',
      reason: 'repo_missing',
    });
    expect([...runner.calls.keys()]).toEqual(['load-refs']);
    expect(fake.db.graph).toBeNull();
  });

  it('a busy clone (another sync holds the lock) skips without marking failed', async () => {
    deps.cache.ensureClone = () => Promise.reject(new RepoBusyError());
    const runner = createFakeRunner({ retries: 1 });
    expect(await treeSyncHandler({ event, step: runner.step }, deps)).toEqual({
      status: 'skipped',
      reason: 'busy',
    });
    expect(runner.calls.get('fetch')).toBe(2); // retried once, then gave up
    expect(fake.db.graph?.status).toBe('syncing');
    expect(runner.calls.has('mark-failed')).toBe(false);
  });

  describe('merged step', () => {
    beforeEach(() => {
      repo.branch('fix/squashed', 'main');
      repo.commit('squash me');
      repo.checkout('main');
      repo.branch('fix/rebased', 'main');
      repo.commit('rebase me');
      repo.checkout('main');
      fm.state.answer.set('fix/squashed', 'squashed');
      fm.state.answer.set('fix/rebased', 'rebased');
      fm.state.answer.set('feature/login', null);
    });

    const snapBranch = (name: string) =>
      TreeSnapshotSchema.parse(fake.db.graph!.snapshot).branches.find((b) => b.name === name)!;

    it('runs between ci and snapshot and feeds content results into the snapshot', async () => {
      const runner = createFakeRunner();
      expect(await treeSyncHandler({ event, step: runner.step }, deps)).toMatchObject({
        status: 'ready',
      });
      expect([...runner.calls.keys()]).toEqual(['load-refs', 'fetch', 'ci', 'merged', 'snapshot']);
      expect(fm.state.detectCalls).toHaveLength(1);
      expect(fm.state.detectCalls[0]!.check.map((b) => [b.name, b.compareWith]).sort()).toEqual([
        ['feature/login', 'main'],
        ['fix/rebased', 'main'],
        ['fix/squashed', 'main'],
      ]);
      expect(runner.outputs.get('merged')).toEqual({
        checked: 3,
        merged: 2,
        byVia: { pr: 0, rebased: 1, squashed: 1 },
      });
      expect(snapBranch('fix/squashed').merged).toEqual({
        via: 'squashed',
        prNumber: null,
        method: null,
        into: 'main',
        newCommits: 0,
        mergeCommitSha: null,
      });
      expect(snapBranch('fix/rebased').merged?.via).toBe('rebased');
      expect(snapBranch('feature/login').merged).toBeNull();
      const main = repo.head('main');
      expect(fm.state.hash).toEqual(
        new Map([
          [mergedCacheField('fix/squashed', repo.head('fix/squashed'), main), 'squashed'],
          [mergedCacheField('fix/rebased', repo.head('fix/rebased'), main), 'rebased'],
          [mergedCacheField('feature/login', repo.head('feature/login'), main), 'none'],
        ]),
      );
    });

    it('a cache hit skips the workspace; a moved head is checked again', async () => {
      await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
      fm.state.detectCalls = [];

      const runner = createFakeRunner();
      await treeSyncHandler({ event, step: runner.step }, deps);
      expect(fm.state.detectCalls).toEqual([]);
      expect(runner.outputs.get('merged')).toEqual({
        checked: 0,
        merged: 2,
        byVia: { pr: 0, rebased: 1, squashed: 1 },
      });
      expect(snapBranch('fix/squashed').merged?.via).toBe('squashed');

      repo.checkout('fix/squashed');
      repo.commit('more work');
      repo.checkout('main');
      fm.state.answer.set('fix/squashed', null);
      await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
      expect(fm.state.detectCalls.map((c) => c.check.map((b) => b.name))).toEqual([
        ['fix/squashed'],
      ]);
      expect(snapBranch('fix/squashed').merged).toBeNull();
      expect(snapBranch('fix/rebased').merged?.via).toBe('rebased');
      expect(fm.state.hash.size).toBe(3); // the old head's field is dropped
    });

    it('a branch with a merged PR uses rule 1 and never reaches the workspace', async () => {
      prs = [
        pr({
          number: 7,
          headRef: 'fix/squashed',
          headSha: repo.head('fix/squashed'),
          state: 'merged',
          mergedAt: NOW.toISOString(),
        }),
      ];
      const runner = createFakeRunner();
      await treeSyncHandler({ event, step: runner.step }, deps);
      expect(fm.state.detectCalls[0]!.check.map((b) => b.name)).not.toContain('fix/squashed');
      expect(runner.outputs.get('merged')).toMatchObject({ byVia: { pr: 1, squashed: 0 } });
      expect(snapBranch('fix/squashed').merged).toMatchObject({ via: 'pr', prNumber: 7 });
    });

    it('a workspace error never fails the sync: logged, branches unmerged, nothing cached', async () => {
      fm.state.fail = new Error('[timeout] workspace for acme/web fix/squashed timed out');
      const runner = createFakeRunner({ retries: 0 });
      const result = await treeSyncHandler({ event, step: runner.step }, deps);
      expect(result).toMatchObject({ status: 'ready' });
      expect(fake.db.graph?.status).toBe('ready');
      expect(snapBranch('fix/squashed').merged).toBeNull();
      expect(fm.state.hash.size).toBe(0);
      expect(runner.outputs.get('merged')).toEqual({
        checked: 3,
        merged: 0,
        byVia: { pr: 0, rebased: 0, squashed: 0 },
      });
      expect(log.warn).toHaveBeenCalledWith(
        { repoId: REPO.id, reason: 'workspace_failed', errorCode: 'timeout' },
        expect.any(String),
      );
      const logged = JSON.stringify(log.warn.mock.calls);
      expect(logged).not.toMatch(/fix\/squashed|acme/);
    });

    it('a git-auth error in the merged step is a workspace failure too', async () => {
      let calls = 0;
      deps.github.gitAuth = async () => {
        if (++calls > 1) throw new Error('token failed'); // `fetch` gets one, `merged` does not
        return auth;
      };
      const runner = createFakeRunner({ retries: 0 });
      expect(await treeSyncHandler({ event, step: runner.step }, deps)).toMatchObject({
        status: 'ready',
      });
      expect(fm.state.detectCalls).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'workspace_failed' }),
        expect.any(String),
      );
    });

    it('branches the detector did not check (cap, timeout) are not cached', async () => {
      fm.state.answer.delete('fix/rebased');
      await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
      expect([...fm.state.hash.values()].sort()).toEqual(['none', 'squashed']);
      fm.state.detectCalls = [];
      await treeSyncHandler({ event, step: createFakeRunner().step }, deps);
      expect(fm.state.detectCalls.map((c) => c.check.map((b) => b.name))).toEqual([
        ['fix/rebased'],
      ]);
    });

    it('a cache outage does not fail the sync', async () => {
      fm.merged.readCache = () => Promise.reject(new Error('redis down'));
      fm.merged.writeCache = () => Promise.reject(new Error('redis down'));
      expect(await treeSyncHandler({ event, step: createFakeRunner().step }, deps)).toMatchObject({
        status: 'ready',
      });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'cache_unavailable' }),
        expect.any(String),
      );
    });
  });

  it('fetches CI for at most 200 heads per run, default branch first', async () => {
    const heads = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(40, '0'));
    deps.github.listBranches = async () => ({
      defaultBranch: 'main',
      branches: [
        ...heads.map((h, i) => ({ name: `b${i}`, headSha: h })),
        { name: 'main', headSha: 'c'.repeat(40) },
      ],
    });
    deps.cache.ensureClone = async () => ({ action: 'fetched' });
    deps.cache.readGraph = async () => ({ commits: [], truncated: false, missing: new Set() });
    const runner = createFakeRunner({ retries: 0 });
    await treeSyncHandler({ event, step: runner.step }, deps);
    expect(ciCalls).toHaveLength(CI_MAX_PER_RUN);
    expect(ciCalls[0]).toBe('c'.repeat(40));
    expect(runner.outputs.get('ci')).toEqual({
      heads: 251,
      cached: 0,
      fetched: 200,
      deferred: 51,
    });
  });
});

describe('planBranches', () => {
  const row = (
    name: string,
    headSha: string,
    extra: Partial<{ isDefault: boolean; deletedAt: Date }> = {},
  ) => ({
    name,
    headSha,
    isDefault: false,
    deletedAt: null,
    ...extra,
  });

  it('creates new, updates moved / restored / default-changed, soft-deletes gone', () => {
    const plan = planBranches(
      [
        row('main', 'a', { isDefault: true }),
        row('same', 'b'),
        row('moved', 'c'),
        row('gone', 'd'),
        row('back', 'e', { deletedAt: new Date() }),
        row('old-gone', 'f', { deletedAt: new Date() }),
      ],
      [
        { name: 'main', headSha: 'a' },
        { name: 'same', headSha: 'b' },
        { name: 'moved', headSha: 'c2' },
        { name: 'back', headSha: 'e' },
        { name: 'new', headSha: 'g' },
        { name: 'new', headSha: 'g' },
      ],
      'main',
    );
    expect(plan).toEqual({
      create: [{ name: 'new', headSha: 'g', isDefault: false }],
      update: [
        { name: 'moved', headSha: 'c2', isDefault: false, restored: false },
        { name: 'back', headSha: 'e', isDefault: false, restored: true },
      ],
      softDelete: ['gone'],
    });
  });

  it('a default-branch change updates both branches', () => {
    const plan = planBranches(
      [row('main', 'a', { isDefault: true }), row('dev', 'b')],
      [
        { name: 'main', headSha: 'a' },
        { name: 'dev', headSha: 'b' },
      ],
      'dev',
    );
    expect(plan.update.map((u) => [u.name, u.isDefault])).toEqual([
      ['main', false],
      ['dev', true],
    ]);
  });
});

describe('planPrs', () => {
  const existing: ExistingPr = {
    number: 1,
    state: 'open',
    headSha: 'a',
    baseRef: 'main',
    baseSha: '0'.repeat(40),
    mergedAt: null,
    mergeCommitSha: null,
  };

  it('creates unknown PRs and updates only when a tree field changed', () => {
    const same = pr({ number: 1, headRef: 'x', headSha: 'a', title: 'renamed' });
    const merged = pr({
      number: 1,
      headRef: 'x',
      headSha: 'a',
      state: 'merged',
      mergedAt: '2026-11-20T00:00:00Z',
      mergeCommitSha: 'm',
    });
    const fresh = pr({ number: 2, headRef: 'y', headSha: 'b' });
    expect(planPrs([existing], [same, fresh])).toEqual({ create: [fresh], update: [] });
    expect(planPrs([existing], [merged]).update).toEqual([merged]);
    expect(
      planPrs(
        [
          {
            ...existing,
            mergedAt: new Date('2026-11-20T00:00:00Z'),
            state: 'merged',
            mergeCommitSha: 'm',
          },
        ],
        [merged],
      ),
    ).toEqual({ create: [], update: [] });
  });
});

describe('applyContentMerged', () => {
  const node = (name: string, headSha: string, extra: object = {}) => ({
    name,
    headSha,
    headCommittedAt: null,
    isDefault: false,
    compareWith: 'main' as string | null,
    why: 'inferred' as const,
    whyPr: null,
    ambiguous: null,
    loop: false,
    ahead: 1,
    behind: 0,
    mergeBase: null,
    merged: null as null | {
      via: 'pr' | 'rebased' | 'squashed';
      prNumber: number | null;
      method: null;
      into: string;
      newCommits: number;
      mergeCommitSha: string | null;
    },
    pr: null,
    ci: 'none' as const,
    recorded: false,
    ...extra,
  });

  it('marks only unmerged branches whose head and target match the cached field', () => {
    const heads = new Map([
      ['main', 'm1'],
      ['a', 'a1'],
      ['b', 'b1'],
      ['c', 'c1'],
    ]);
    const prMerged = {
      via: 'pr' as const,
      prNumber: 3,
      method: null,
      into: 'main',
      newCommits: 0,
      mergeCommitSha: null,
    };
    const branches = [
      node('main', 'm1', { isDefault: true, compareWith: null }),
      node('a', 'a1'),
      node('b', 'b1', { merged: prMerged }),
      node('c', 'c1'),
    ];
    applyContentMerged(
      branches,
      heads,
      new Map([
        [mergedCacheField('a', 'a1', 'm1'), 'squashed'],
        [mergedCacheField('b', 'b1', 'm1'), 'rebased'],
        [mergedCacheField('c', 'c1', 'OLD'), 'rebased'],
      ]),
    );
    expect(branches.map((b) => b.merged?.via ?? null)).toEqual([null, 'squashed', 'pr', null]);
  });
});

describe('redisTreeMerged', () => {
  it('replaces the hash and sets a 7-day TTL; ids and SHAs only', async () => {
    const ops: unknown[][] = [];
    const redis = {
      hgetall: async (k: string) => (ops.push(['hgetall', k]), { f: 'squashed' }),
      multi: () => ({
        del: (k: string) => ops.push(['del', k]),
        hset: (k: string, v: Record<string, string>) => ops.push(['hset', k, v]),
        expire: (k: string, s: number) => ops.push(['expire', k, s]),
        exec: async () => ops.push(['exec']),
      }),
    };
    const m = redisTreeMerged(redis, async () => new Map());
    expect(await m.readCache('repo_1')).toEqual(new Map([['f', 'squashed']]));
    await m.writeCache('repo_1', new Map([['x@a@b', 'none']]));
    await m.writeCache('repo_1', new Map());
    expect(MERGED_CACHE_TTL_S).toBe(604_800);
    expect(ops).toEqual([
      ['hgetall', 'tree:merged:repo_1'],
      ['del', 'tree:merged:repo_1'],
      ['hset', 'tree:merged:repo_1', { 'x@a@b': 'none' }],
      ['expire', 'tree:merged:repo_1', 604_800],
      ['exec'],
      ['del', 'tree:merged:repo_1'],
      ['exec'],
    ]);
  });
});

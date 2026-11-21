import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrRecord } from '../src';
import {
  assertNoContents,
  detectMergedWithFallbacks,
  objectCounts,
  readCommitGraph,
  sweepStaleWorkspaces,
  withContentWorkspace,
  WorkspaceTimeoutError,
  WORKSPACE_PREFIX,
  type GitAuth,
} from '../src/git';
import {
  allFixtures,
  commitsOnlyClone,
  gitAtLeast,
  ISOLATED_GIT_ENV,
  type BuiltFixture,
} from '../src/testing';

// merge-tree --write-tree needs git >= 2.38.
const canRun = gitAtLeast(2, 38);
if (!canRun) console.warn('[git-graph] workspace tests skipped: git >= 2.38 required');
const d = canRun ? describe : describe.skip;

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function setUp(fx: BuiltFixture) {
  const cache = commitsOnlyClone(fx.repo);
  cleanup.push(() => {
    cache.remove();
    fx.repo.remove();
  });
  const auth: GitAuth = { url: fx.repo.url, env: ISOLATED_GIT_ENV };
  return { cache: cache.gitDir, auth };
}

async function graphInput(fx: BuiltFixture, cacheGitDir: string, prs: PrRecord[] = fx.prs) {
  const branches = fx.repo.branches().map((name) => ({
    name,
    headSha: fx.repo.head(name),
    recordedParents: fx.recordedParents[name],
  }));
  const { commits } = await readCommitGraph(
    cacheGitDir,
    branches.map((b) => b.headSha),
    { env: ISOLATED_GIT_ENV },
  );
  return {
    defaultBranch: fx.defaultBranch,
    branches,
    graph: commits,
    prs,
    overrides: fx.overrides,
  };
}

const mergedFields = (fx: BuiltFixture, name: string) => {
  const pr = fx.expectedMerged[name];
  if (pr) return pr;
  const via = fx.expectedContent[name];
  return via
    ? { via, prNumber: null, method: null, into: 'main', newCommits: 0, mergeCommitSha: null }
    : null;
};

d('detectMergedWithFallbacks on every fixture (PR records as given)', () => {
  for (const [key, build] of Object.entries(allFixtures)) {
    it(key, async () => {
      const fx = build();
      const { cache, auth } = setUp(fx);
      const res = await detectMergedWithFallbacks(cache, auth, await graphInput(fx, cache));
      expect(res.failed).toEqual([]);
      expect(res.skipped).toEqual([]);
      for (const [name, m] of res.merged) expect(m, name).toEqual(mergedFields(fx, name));
      await assertNoContents(cache);
    });
  }
});

d('merged-state detection: each merge kind, with and without a PR record', () => {
  it('api-server demo: docs/setup → merged via #3 (rebase)', async () => {
    const fx = allFixtures.apiServer();
    const { cache, auth } = setUp(fx);
    const res = await detectMergedWithFallbacks(cache, auth, await graphInput(fx, cache));
    expect(res.merged.get('docs/setup')).toMatchObject({
      via: 'pr',
      prNumber: 3,
      method: 'rebase',
    });
    expect(res.merged.get('docs/setup')?.mergeCommitSha).toBe(fx.repo.head('main'));
    // Rule 1 settled it: docs/setup never went into the workspace (dev and feature/rate-limit did).
    expect(res.content.has('docs/setup')).toBe(false);
    expect([...res.content.keys()].sort()).toEqual(['dev', 'feature/rate-limit']);
  });

  it('squash / rebase without a PR → squashed / rebased; merge without a PR → not marked', async () => {
    const sq = allFixtures.squashMerge();
    const s = setUp(sq);
    const r1 = await detectMergedWithFallbacks(s.cache, s.auth, await graphInput(sq, s.cache, []));
    expect(r1.merged.get('feature/sq')?.via).toBe('squashed');
    expect(r1.merged.get('feature/sq-nopr')?.via).toBe('squashed');

    const rb = allFixtures.rebaseMerge();
    const r = setUp(rb);
    const r2 = await detectMergedWithFallbacks(r.cache, r.auth, await graphInput(rb, r.cache, []));
    expect(r2.merged.get('feature/rb')?.via).toBe('rebased');
    expect(r2.merged.get('feature/rb-nopr')?.via).toBe('rebased');
    expect(r2.merged.get('feature/partial')).toBeNull(); // only its first commit was picked

    const mc = allFixtures.mergeCommit();
    const m = setUp(mc);
    const r3 = await detectMergedWithFallbacks(m.cache, m.auth, await graphInput(mc, m.cache, []));
    expect(r3.merged.get('feature/a')).toBeNull(); // ↑0: merged with a merge commit
    expect(r3.merged.get('feature/c')).toBeNull();
    expect(r3.merged.get('feature/b')).toBeNull(); // a new commit after the merge

    for (const dir of [s.cache, r.cache, m.cache]) await assertNoContents(dir);
  });

  it('branch moved after its PR merged → newCommits', async () => {
    const fx = allFixtures.mergeCommit();
    const { cache, auth } = setUp(fx);
    const res = await detectMergedWithFallbacks(cache, auth, await graphInput(fx, cache));
    expect(res.merged.get('feature/b')).toMatchObject({ via: 'pr', prNumber: 2, newCommits: 1 });
  });

  it('maxBranches: the rest are skipped, not marked', async () => {
    const fx = allFixtures.rebaseMerge();
    const { cache, auth } = setUp(fx);
    const res = await detectMergedWithFallbacks(cache, auth, await graphInput(fx, cache, []), {
      maxBranches: 1,
    });
    expect(res.content.size).toBe(1);
    expect(res.skipped).toHaveLength(2);
  });
});

d('withContentWorkspace', () => {
  it('fetches contents into the temp repo only, then removes it', async () => {
    const fx = allFixtures.squashMerge();
    const { cache, auth } = setUp(fx);
    const main = fx.repo.head('main');
    const nopr = fx.repo.head('feature/sq-nopr');
    let wsDir = '';
    const result = await withContentWorkspace(
      cache,
      auth,
      async (ws) => {
        wsDir = dirname(ws.gitDir);
        const [mt, tt] = await Promise.all([ws.mergeTreeId(main, nopr), ws.treeId(main)]);
        const patches = await ws.patchIds(`${main}..${nopr}`);
        // Lazily fetched trees/blobs are in the workspace (alternates are counted too, but the cache
        // has none of its own, as checked below).
        const counts = await objectCounts(ws.gitDir);
        return { same: mt === tt, patches: patches.size, trees: counts.tree ?? 0 };
      },
      { timeoutMs: 30_000 },
    );
    expect(result).toEqual({ same: true, patches: 2, trees: expect.any(Number) });
    expect(result.trees).toBeGreaterThan(0);
    expect(wsDir.startsWith(join(tmpdir(), WORKSPACE_PREFIX))).toBe(true);
    expect(existsSync(wsDir)).toBe(false);
    await assertNoContents(cache);
  });

  it('removes the temp dir when fn throws', async () => {
    const fx = allFixtures.stacked();
    const { cache, auth } = setUp(fx);
    let wsDir = '';
    await expect(
      withContentWorkspace(
        cache,
        auth,
        async (ws) => {
          wsDir = dirname(ws.gitDir);
          throw new Error('boom');
        },
        { timeoutMs: 30_000 },
      ),
    ).rejects.toThrow('boom');
    expect(wsDir).not.toBe('');
    expect(existsSync(wsDir)).toBe(false);
  });

  it('timeout kills git (and the fetch it started) and still cleans up', async () => {
    const fx = allFixtures.squashMerge();
    const { cache } = setUp(fx);
    // A "remote" that accepts connections and never answers: the lazy fetch hangs on it.
    const sockets = new Set<Socket>();
    let closed = 0;
    const server = createServer((s) => {
      sockets.add(s);
      s.resume(); // read (and drop) the request; a paused socket never reports the peer closing
      s.on('close', () => closed++);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const auth: GitAuth = { url: `http://127.0.0.1:${port}/repo.git`, env: ISOLATED_GIT_ENV };
    let wsDir = '';
    try {
      const started = Date.now();
      const err = await withContentWorkspace(
        cache,
        auth,
        async (ws) => {
          wsDir = dirname(ws.gitDir);
          return ws.mergeTreeId(fx.repo.head('main'), fx.repo.head('feature/sq-nopr'));
        },
        { timeoutMs: 1_500 },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkspaceTimeoutError);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(existsSync(wsDir)).toBe(false);
      // The helper process that held the connection (git-remote-http, a grandchild) was killed with the
      // group, so the server sees the connection close.
      expect(sockets.size).toBeGreaterThan(0);
      const until = Date.now() + 5_000;
      while (closed < sockets.size && Date.now() < until)
        await new Promise((r) => setTimeout(r, 50));
      expect(closed).toBe(sockets.size);
      await assertNoContents(cache);
    } finally {
      sockets.forEach((s) => s.destroy());
      server.close();
    }
  });

  it('sweeps stale workspace dirs left by a dead process', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-graph-sweep-'));
    try {
      const old = join(root, `${WORKSPACE_PREFIX}old`);
      const fresh = join(root, `${WORKSPACE_PREFIX}fresh`);
      const other = join(root, 'something-else');
      for (const dir of [old, fresh, other]) mkdirSync(dir);
      const past = new Date(Date.now() - 2 * 60 * 60_000);
      utimesSync(old, past, past);
      utimesSync(other, past, past);
      expect(sweepStaleWorkspaces(60 * 60_000, root)).toBe(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

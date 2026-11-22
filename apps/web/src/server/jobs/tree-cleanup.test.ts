import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRunner } from './__fixtures__/fake-step';
import type { RepoLock } from './repo-cache';
import {
  TREE_CLONE_KEEP_MS,
  TREE_LEFTOVER_MS,
  treeCleanupHandler,
  type TreeCleanupDeps,
} from './tree-cleanup';

const NOW = new Date('2026-11-22T04:17:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60_000;

let dir: string;
let held: Set<string>;
let deps: TreeCleanupDeps;
let active: { id: string; githubRepoId: number }[];
let views: Map<string, Date>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A clone made `at` (git writes HEAD once, at clone time) plus its graph file. */
function clone(id: number, at: Date) {
  const git = path.join(dir, `${id}.git`);
  mkdirSync(path.join(git, 'objects'), { recursive: true });
  writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  utimesSync(path.join(git, 'HEAD'), at, at);
  writeFileSync(path.join(dir, `${id}.graph`), 'x');
}
function leftover(name: string, at: Date, isDir = false) {
  const p = path.join(dir, name);
  if (isDir) mkdirSync(p);
  else writeFileSync(p, 'x');
  utimesSync(p, at, at);
}
const run = () => treeCleanupHandler({ step: createFakeRunner().step }, deps);
const has = (id: number) => existsSync(path.join(dir, `${id}.git`));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 't7-cleanup-'));
  held = new Set();
  active = [];
  views = new Map();
  log.info.mockReset();
  const lock: RepoLock = {
    async acquire(key) {
      if (held.has(key)) return null;
      held.add(key);
      return 'x';
    },
    async release(key) {
      held.delete(key);
    },
  };
  deps = {
    cacheDir: dir,
    lock,
    activeRepos: async (ids) => active.filter((r) => ids.includes(r.githubRepoId)),
    viewedSince: async (since) => [...views].filter(([, t]) => t >= since).map(([id]) => id),
    async dropViewsBefore(before) {
      for (const [id, t] of views) if (t < before) views.delete(id);
    },
    sweepWorkspaces: vi.fn(() => 2),
    now: () => NOW,
    log,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tree-cleanup', () => {
  it('keeps viewed repos; deletes clones (and graphs) not viewed in 30 days', async () => {
    active = [
      { id: 'viewed', githubRepoId: 1 },
      { id: 'stale', githubRepoId: 2 },
    ];
    clone(1, ago(90 * DAY));
    clone(2, ago(90 * DAY));
    views.set('viewed', ago(29 * DAY));
    views.set('stale', ago(31 * DAY));
    const out = await run();
    expect(out).toMatchObject({ clones: 2, removed: 1, notViewed: 1, gone: 0, busy: 0 });
    expect(has(1)).toBe(true);
    expect(has(2)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['1.git', '1.graph']);
    expect([...views.keys()]).toEqual(['viewed']);
    expect(held.size).toBe(0);
  });

  it('deletes clones of repos removed from the installation, however recent', async () => {
    clone(3, ago(1000));
    const out = await run();
    expect(out).toMatchObject({ removed: 1, gone: 1, notViewed: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('no view on record (Redis lost it): counts from when the clone was made', async () => {
    active = [
      { id: 'a', githubRepoId: 4 },
      { id: 'b', githubRepoId: 5 },
    ];
    clone(4, ago(TREE_CLONE_KEEP_MS - DAY));
    clone(5, ago(TREE_CLONE_KEEP_MS + DAY));
    await run();
    expect(has(4)).toBe(true);
    expect(has(5)).toBe(false);
  });

  it('skips a clone a sync holds, and deletes nothing when the DB or Redis is down', async () => {
    clone(6, ago(90 * DAY));
    held.add('tree:clone-lock:6');
    expect(await run()).toMatchObject({ removed: 0, busy: 1 });
    expect(has(6)).toBe(true);
    held.clear();
    const { activeRepos, viewedSince } = deps;
    deps.activeRepos = async () => Promise.reject(new Error('db down'));
    await expect(run()).rejects.toThrow('db down');
    deps.activeRepos = activeRepos;
    deps.viewedSince = async () => Promise.reject(new Error('redis down'));
    await expect(run()).rejects.toThrow('redis down');
    deps.viewedSince = viewedSince;
    expect(has(6)).toBe(true);
  });

  it('removes leftovers older than 1 h and nothing it does not know', async () => {
    const old = ago(TREE_LEFTOVER_MS + 1000);
    const fresh = ago(TREE_LEFTOVER_MS - 60_000);
    leftover('7.git.tmp-0a1b2c3d', old, true);
    leftover('8.git.tmp-0a1b2c3d', fresh, true);
    leftover('7.graph.12.1763784000000.tmp', old);
    leftover('8.graph.12.1763784000000.tmp', fresh);
    leftover('README', old);
    leftover('other.git', old, true);
    const out = await run();
    expect(out).toMatchObject({ clones: 0, leftovers: 2, workspaces: 2 });
    expect(deps.sweepWorkspaces).toHaveBeenCalledWith(60 * 60_000);
    expect(readdirSync(dir).sort()).toEqual([
      '8.git.tmp-0a1b2c3d',
      '8.graph.12.1763784000000.tmp',
      'README',
      'other.git',
    ]);
  });

  it('nothing cloned yet (no cache dir) is fine; outputs are counts only', async () => {
    rmSync(dir, { recursive: true });
    const out = await run();
    expect(Object.values(out).every((v) => typeof v === 'number')).toBe(true);
    expect(log.info).toHaveBeenCalledWith(out, 'tree-cleanup done');
  });
});

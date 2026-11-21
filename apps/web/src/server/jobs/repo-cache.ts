// Commits-only clones for the branch tree (tasks/T-branch-tree.md → "Decisions", "Privacy rules").
// One bare clone per repo at `${REPO_CACHE_DIR}/<githubRepoId>.git`, holding commits only: no trees, no
// blobs. Node only. Every git call goes through `runGit` (no shell, prompts off, errors scrubbed).
//
// Why the config dance after every clone/fetch: on git 2.43 `remote.origin.promisor=false` alone does
// NOT stop lazy fetches; `remote.origin.partialclonefilter` still registers origin as a promisor remote.
// And `git fetch --filter=…` turns both back on. So after every clone/fetch we set promisor=false and
// unset partialclonefilter: from then on a missing tree is an error, never a download into the cache.
// GIT_NO_LAZY_FETCH=1 (set by runGit) is a second guard on git >= 2.44.
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitError, readCommitGraph, runGit, type RunGitOptions } from '@app/git-graph/git';
import type { CommitInput } from '@app/git-graph';
import { retriable } from './errors';
import type { JobLogger } from './deps';

/** What git needs to reach the repo. `url` never contains a token; auth travels in `env`. */
export interface GitAuth {
  url: string;
  env: Record<string, string>;
}

export interface CacheRepo {
  githubRepoId: number;
}

export interface RepoLock {
  /** Returns a release token, or null if someone else holds the lock. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** Releases only if `token` still owns the lock. */
  release(key: string, token: string): Promise<void>;
}

/** The subset of ioredis the lock uses. */
export interface LockRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Per-key lock with Redis `SET NX PX`; release is compare-and-delete so an expired holder can't free a newer one. */
export function redisRepoLock(redis: LockRedis): RepoLock {
  return {
    async acquire(key, ttlMs) {
      const token = randomBytes(16).toString('hex');
      return (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null;
    },
    async release(key, token) {
      await redis.eval(RELEASE_LUA, 1, key, token);
    },
  };
}

export const REPO_LOCK_TTL_MS = 10 * 60_000;

export class RepoBusyError extends Error {
  constructor() {
    super('[internal] another sync holds this repo clone');
    this.name = 'RepoBusyError';
  }
}

export interface LockOptions {
  /** How long to wait for the lock before giving up (default 0 = skip at once). */
  waitMs?: number;
  pollMs?: number;
  ttlMs?: number;
}

/** Run `fn` while holding the repo's clone lock. Throws `RepoBusyError` if it can't get it in `waitMs`. */
export async function withRepoLock<T>(
  lock: RepoLock,
  githubRepoId: number,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const key = `tree:clone-lock:${githubRepoId}`;
  const deadline = Date.now() + (opts.waitMs ?? 0);
  let token = await lock.acquire(key, opts.ttlMs ?? REPO_LOCK_TTL_MS);
  while (!token && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
    token = await lock.acquire(key, opts.ttlMs ?? REPO_LOCK_TTL_MS);
  }
  if (!token) throw new RepoBusyError();
  try {
    return await fn();
  } finally {
    await lock.release(key, token).catch(() => {}); // the TTL frees it anyway
  }
}

export function cloneDir(cacheDir: string, githubRepoId: number): string {
  if (!Number.isSafeInteger(githubRepoId) || githubRepoId <= 0) throw new Error('invalid repo id');
  return path.resolve(cacheDir, `${githubRepoId}.git`);
}

export interface EnsureCloneOptions {
  cacheDir: string;
  lock: RepoLock;
  lockWaitMs?: number;
  /** run `assertNoContents` after the clone/fetch (tests; prod behind TREE_ASSERT_NO_CONTENTS=1) */
  assertNoContents?: boolean;
  timeoutMs?: number;
  log?: JobLogger;
}

export type EnsureCloneAction = 'cloned' | 'fetched' | 'recloned';

/**
 * Make sure the repo's commits-only clone exists and is current. Missing → clone; present → fetch.
 * A corrupt clone is deleted and cloned again, once. Holds the repo lock throughout.
 */
export async function ensureClone(
  repo: CacheRepo,
  auth: GitAuth,
  opts: EnsureCloneOptions,
): Promise<{ gitDir: string; action: EnsureCloneAction }> {
  const gitDir = cloneDir(opts.cacheDir, repo.githubRepoId);
  const gitOpts: RunGitOptions = { env: auth.env, timeoutMs: opts.timeoutMs };
  return withRepoLock(
    opts.lock,
    repo.githubRepoId,
    async () => {
      let action: EnsureCloneAction;
      if (!(await exists(gitDir))) {
        await freshClone(gitDir, auth, gitOpts);
        action = 'cloned';
      } else if (!(await healthy(gitDir))) {
        opts.log?.warn({ githubRepoId: repo.githubRepoId }, 'tree clone corrupt, recloning');
        await rm(gitDir, { recursive: true, force: true });
        await freshClone(gitDir, auth, gitOpts);
        action = 'recloned';
      } else {
        try {
          await fetchClone(gitDir, auth, gitOpts);
          action = 'fetched';
        } catch (err) {
          // A failed fetch on a now-broken clone → reclone once. A healthy clone → real fetch error.
          if (await healthy(gitDir)) throw gitFailure('fetch', err);
          opts.log?.warn({ githubRepoId: repo.githubRepoId }, 'tree clone corrupt, recloning');
          await rm(gitDir, { recursive: true, force: true });
          await freshClone(gitDir, auth, gitOpts);
          action = 'recloned';
        }
      }
      if (opts.assertNoContents) await assertNoContents(gitDir);
      return { gitDir, action };
    },
    { waitMs: opts.lockWaitMs },
  );
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Commits read from the clone per sync; past this the snapshot is marked truncated. */
export const TREE_READ_MAX_COMMITS = 100_000;

/**
 * Commits reachable from `heads` (SHAs), under the repo lock. Heads the clone does not have (moved after
 * the fetch) are returned in `missing` instead of failing the read. Never lazily fetches.
 */
export async function readCloneGraph(
  repo: CacheRepo,
  heads: readonly string[],
  opts: { cacheDir: string; lock: RepoLock; lockWaitMs?: number; maxCommits?: number },
): Promise<{
  commits: CommitInput[];
  truncated: boolean;
  missing: Set<string>;
}> {
  const gitDir = cloneDir(opts.cacheDir, repo.githubRepoId);
  const valid = heads.filter((h) => SHA_RE.test(h));
  return withRepoLock(
    opts.lock,
    repo.githubRepoId,
    async () => {
      const missing = new Set(heads.filter((h) => !SHA_RE.test(h)));
      if (valid.length) {
        const { stdout } = await runGit(
          ['--git-dir', gitDir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
          { input: `${valid.join('\n')}\n` },
        );
        const found = new Set<string>();
        for (const line of stdout.split('\n')) {
          const [sha, type] = line.split(' ');
          if (sha && type === 'commit') found.add(sha);
        }
        for (const h of valid) if (!found.has(h)) missing.add(h);
      }
      const present = valid.filter((h) => !missing.has(h));
      const { commits, truncated } = await readCommitGraph(gitDir, present, {
        maxCommits: opts.maxCommits ?? TREE_READ_MAX_COMMITS,
      });
      return { commits, truncated, missing };
    },
    { waitMs: opts.lockWaitMs },
  );
}

/** Throws if the clone holds any tree or blob (i.e. file contents or names). */
export async function assertNoContents(gitDir: string): Promise<void> {
  const { stdout } = await runGit([
    '--git-dir',
    gitDir,
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objecttype)',
  ]);
  const counts: Record<string, number> = {};
  for (const type of stdout.split('\n')) if (type) counts[type] = (counts[type] ?? 0) + 1;
  const trees = counts.tree ?? 0;
  const blobs = counts.blob ?? 0;
  if (trees || blobs) {
    throw new Error(`[internal] cache clone holds contents (${trees} trees, ${blobs} blobs)`);
  }
}

// --- internals ---

async function freshClone(gitDir: string, auth: GitAuth, opts: RunGitOptions): Promise<void> {
  await mkdir(path.dirname(gitDir), { recursive: true });
  // Clone next to the target and rename, so a crash never leaves a half clone at `gitDir`.
  const tmp = `${gitDir}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await runGit(
      ['clone', '--bare', '--filter=tree:0', '--no-tags', '--quiet', '--', auth.url, tmp],
      opts,
    ).catch((err: unknown) => {
      throw gitFailure('clone', err);
    });
    await lockDown(tmp);
    await git(tmp, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
    // No background gc/maintenance: repacking a clone with missing trees must never be attempted.
    await git(tmp, ['config', 'gc.auto', '0']);
    await git(tmp, ['config', 'maintenance.auto', 'false']);
    await rename(tmp, gitDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function fetchClone(gitDir: string, auth: GitAuth, opts: RunGitOptions): Promise<void> {
  // The URL can change (repo renamed/transferred); it never holds a token.
  await git(gitDir, ['config', 'remote.origin.url', auth.url]);
  try {
    await runGit(
      [
        '--git-dir',
        gitDir,
        'fetch',
        '--prune',
        '--filter=tree:0',
        '--no-tags',
        '--quiet',
        'origin',
      ],
      opts,
    );
  } finally {
    await lockDown(gitDir).catch(() => {});
  }
}

/** Make origin a non-promisor remote so nothing is ever lazily fetched into the cache. */
async function lockDown(gitDir: string): Promise<void> {
  await git(gitDir, ['config', 'remote.origin.promisor', 'false']);
  // exit 5 = key not set
  await runGit(['--git-dir', gitDir, 'config', '--unset-all', 'remote.origin.partialclonefilter'], {
    okExitCodes: [0, 5],
  });
}

/** Commits-only health check: refs resolve and every commit is readable (trees are not walked). */
async function healthy(gitDir: string): Promise<boolean> {
  try {
    await runGit(['--git-dir', gitDir, 'rev-list', '--count', '--all'], { timeoutMs: 60_000 });
    return true;
  } catch {
    return false;
  }
}

function git(gitDir: string, args: string[]) {
  return runGit(['--git-dir', gitDir, ...args]);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** GitError messages are already scrubbed by runGit; keep one short line and mark it retriable. */
function gitFailure(op: 'clone' | 'fetch', err: unknown): Error {
  const msg = err instanceof GitError ? err.message.split('\n')[0]!.slice(0, 300) : 'git failed';
  return retriable('github_error', `git ${op} failed: ${msg}`);
}

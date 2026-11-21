// Throwaway content workspace (tasks/T-branch-tree.md → "Privacy rules", milestone 3).
//
// Patch ids and test merges need trees and blobs, which the commits-only cache clone must never hold.
// So they run in a temp bare repo made with `git clone --bare --shared <cache> <tmp>`: it borrows the
// cache's commits through `objects/info/alternates` (read-only) and is a promisor clone of the real
// remote, so missing trees/blobs are fetched on demand into `<tmp>/objects`, never into the cache.
// The temp dir is removed in `finally`, even on timeout or throw. Only ids and booleans leave `fn`.
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, runGit, type RunGitOptions } from './run-git';

/** What git needs to reach the repo. `url` never contains a token; auth travels in `env`. */
export interface GitAuth {
  url: string;
  env: Readonly<Record<string, string>>;
}

export interface ContentWorkspace {
  /** the temp git dir (for diagnostics only; never log paths inside it) */
  readonly gitDir: string;
  /** aborted when the workspace times out; pass to anything long-running */
  readonly signal: AbortSignal;
  /** `git patch-id --stable` for each non-merge commit in `range` (e.g. 'T..B'): sha → patch id */
  patchIds(range: string, opts?: CallOptions): Promise<Map<string, string>>;
  /** `git cherry <upstream> <head>` "-" lines: head-only commits whose patch is already upstream */
  cherryMatched(upstream: string, head: string, opts?: CallOptions): Promise<string[]>;
  /** tree of `git merge-tree --write-tree a b`, or null when it conflicts */
  mergeTreeId(a: string, b: string, opts?: CallOptions): Promise<string | null>;
  /** `rev^{tree}` */
  treeId(rev: string, opts?: CallOptions): Promise<string>;
}

export interface CallOptions {
  /** per-call timeout; defaults to what is left of the workspace budget */
  timeoutMs?: number;
}

export interface WorkspaceOptions {
  /** whole-workspace budget, clone included. On expiry every running git (and its helpers) is killed. */
  timeoutMs: number;
}

export class WorkspaceTimeoutError extends Error {
  constructor(ms: number) {
    super(`content workspace timed out after ${ms} ms`);
    this.name = 'WorkspaceTimeoutError';
  }
}

/** Temp dirs are named `<WORKSPACE_PREFIX><random>` under `os.tmpdir()`. */
export const WORKSPACE_PREFIX = 'git-graph-ws-';
/** Leftovers older than this (from a crashed process) are swept when a new workspace opens. */
const STALE_MS = 60 * 60_000;

const live = new Set<string>();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous. SIGKILL/OOM skip this; the stale sweep below covers those.
  process.on('exit', () => {
    for (const dir of live) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
}

/** Remove workspace dirs left by processes that died before their `finally` ran. */
export function sweepStaleWorkspaces(maxAgeMs = STALE_MS, root = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(WORKSPACE_PREFIX)) continue;
    const dir = join(root, name);
    if (live.has(dir)) continue;
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // raced with another process, or not ours
    }
  }
  return removed;
}

function assertRev(rev: string) {
  if (!rev || rev.startsWith('-') || /[\s\0]/.test(rev))
    throw new Error('Invalid revision argument');
}

/**
 * Open a throwaway workspace over the commits-only cache clone at `cacheGitDir`, run `fn`, and delete
 * the workspace whatever happens. `fn` must return ids/booleans only, never file contents or names.
 */
export async function withContentWorkspace<T>(
  cacheGitDir: string,
  auth: GitAuth,
  fn: (ws: ContentWorkspace) => Promise<T>,
  { timeoutMs }: WorkspaceOptions,
): Promise<T> {
  installExitHook();
  sweepStaleWorkspaces();
  const deadline = Date.now() + timeoutMs;
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new WorkspaceTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  expired.catch(() => {}); // handled through the race below

  // mkdtemp creates the dir with mode 0700.
  const dir = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  live.add(dir);
  const gitDir = join(dir, 'ws.git');
  const running = new Set<Promise<unknown>>();

  const git = (args: string[], opts: Omit<RunGitOptions, 'env' | 'signal' | 'killTree'> = {}) => {
    const left = deadline - Date.now();
    if (left <= 0 || ac.signal.aborted) return Promise.reject(new WorkspaceTimeoutError(timeoutMs));
    const p = runGit(args, {
      ...opts,
      env: auth.env,
      signal: ac.signal,
      killTree: true,
      allowLazyFetch: true,
      timeoutMs: Math.min(opts.timeoutMs ?? left, left),
    });
    running.add(p);
    void p.catch(() => {}).finally(() => running.delete(p));
    return p;
  };
  const inWs = (
    args: string[],
    opts: CallOptions & Pick<RunGitOptions, 'input' | 'okExitCodes'> = {},
  ) => git(['--git-dir', gitDir, ...args], opts);

  const ws: ContentWorkspace = {
    gitDir,
    signal: ac.signal,
    async patchIds(range, opts = {}) {
      assertRev(range);
      // The diff text only passes between the two git processes in memory; only ids are returned.
      const log = await inWs(
        [
          'log',
          '--no-merges',
          '-p',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--format=commit %H',
          '--end-of-options',
          range,
        ],
        opts,
      );
      const out = new Map<string, string>();
      if (!log.stdout.trim()) return out;
      // VERIFY: patch-id --stable matches git cherry on renames/binary files (oracle covers text edits).
      const { stdout } = await inWs(['patch-id', '--stable'], { ...opts, input: log.stdout });
      for (const line of stdout.split('\n')) {
        const [patchId, sha] = line.trim().split(' ');
        if (patchId && sha) out.set(sha, patchId);
      }
      return out;
    },
    async cherryMatched(upstream, head, opts = {}) {
      assertRev(upstream);
      assertRev(head);
      // git cherry prints "<+|-> <sha>" only: no subjects (we never pass -v), no diff text.
      const { stdout } = await inWs(['cherry', upstream, head], opts);
      const out: string[] = [];
      for (const line of stdout.split('\n')) {
        const [mark, sha] = line.trim().split(' ');
        if (mark === '-' && sha) out.push(sha);
      }
      return out;
    },
    async mergeTreeId(a, b, opts = {}) {
      assertRev(a);
      assertRev(b);
      // --no-messages keeps file names out of stdout; exit 1 = conflicts.
      const res = await inWs(['merge-tree', '--write-tree', '--no-messages', a, b], {
        ...opts,
        okExitCodes: [0, 1],
      });
      if (res.exitCode !== 0) return null;
      return res.stdout.split('\n')[0]!.trim() || null;
    },
    async treeId(rev, opts = {}) {
      assertRev(rev);
      const { stdout } = await inWs(
        ['rev-parse', '--verify', '--end-of-options', `${rev}^{tree}`],
        opts,
      );
      return stdout.trim();
    },
  };

  // The loser of a race keeps running until its git is killed; never leave its rejection unhandled.
  const guarded = <R>(p: Promise<R>) => {
    p.catch(() => {});
    return Promise.race([p, expired]);
  };
  try {
    await guarded(setUp(git, cacheGitDir, gitDir, auth.url));
    return await guarded(fn(ws));
  } finally {
    clearTimeout(timer);
    ac.abort(); // stop anything `fn` left running
    // Wait for killed git processes to exit so nothing writes into the dir while it is removed.
    await Promise.allSettled([...running]);
    await rm(dir, { recursive: true, force: true }).catch(async () => {
      await new Promise((r) => setTimeout(r, 100));
      await rm(dir, { recursive: true, force: true });
    });
    live.delete(dir);
  }
}

async function setUp(
  git: (args: string[]) => Promise<unknown>,
  cacheGitDir: string,
  gitDir: string,
  url: string,
) {
  // --shared: borrow the cache's objects via alternates; nothing is copied or written back.
  // --no-local is NOT used: a local clone is what lets --shared work without a network fetch.
  try {
    await git(['clone', '--bare', '--shared', '--no-tags', '--quiet', '--', cacheGitDir, gitDir]);
  } catch (e) {
    throw e instanceof GitError ? e : new GitError('git clone failed', null, false);
  }
  const cfg = (k: string, v: string) => git(['--git-dir', gitDir, 'config', k, v]);
  // Make the TEMP repo a promisor clone of the real remote. Missing trees/blobs are fetched on demand
  // into <tmp>/objects. The cache keeps promisor=false (T2c) and is only ever read through alternates.
  // VERIFY: lazily fetched objects land in the workspace's own object dir, never in the alternate
  // (tested in workspace.test.ts on git 2.43; re-check on the production git version).
  await cfg('remote.origin.url', url);
  await cfg('remote.origin.promisor', 'true');
  await cfg('remote.origin.partialclonefilter', 'blob:none');
  // VERIFY: on GitHub, lazy fetch costs one round trip per batch of missing objects (merge-tree fetches
  // trees as it walks). Check a large real repo stays inside the 10 s per-branch budget.
  await cfg('gc.auto', '0');
  await cfg('maintenance.auto', 'false');
}

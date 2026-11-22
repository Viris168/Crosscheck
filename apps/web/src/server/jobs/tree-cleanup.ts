// tree-cleanup (daily cron, T7): drop what the branch tree no longer needs from disk: clones (and graph
// caches) of repos nobody viewed in 30 days or that were removed from the installation, plus leftovers of
// crashed processes. Everything here is a cache: the next sync clones again.
// Privacy: step outputs and logs carry counts only.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@app/db';
import type { JobLogger } from './deps';
import { RepoBusyError, cloneDir, withRepoLock, type RepoLock } from './repo-cache';

/** Daily, off the hour. */
export const TREE_CLEANUP_CRON = '17 4 * * *';
/** Clones of repos not viewed for this long are deleted. */
export const TREE_CLONE_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Half-made clones, graph temp files and workspaces older than this belong to dead processes. */
export const TREE_LEFTOVER_MS = 60 * 60_000;

export interface TreeCleanupDeps {
  cacheDir: string;
  lock: RepoLock;
  /** Active repos among these GitHub ids. Throws when the DB is down (then nothing is deleted). */
  activeRepos(githubRepoIds: readonly number[]): Promise<{ id: string; githubRepoId: number }[]>;
  viewedSince(since: Date): Promise<string[]>;
  dropViewsBefore(before: Date): Promise<void>;
  /** `sweepStaleWorkspaces`: content workspaces (`mkdtemp`) older than `maxAgeMs`. Returns how many. */
  sweepWorkspaces(maxAgeMs: number): number;
  now(): Date;
  log: JobLogger;
}

export interface TreeCleanupStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface TreeCleanupResult {
  clones: number;
  removed: number;
  notViewed: number;
  gone: number;
  busy: number;
  leftovers: number;
  workspaces: number;
}

export async function treeCleanupHandler(
  ctx: { step: TreeCleanupStep },
  deps: TreeCleanupDeps,
): Promise<TreeCleanupResult> {
  const clones = await ctx.step.run('clones', () => cleanClones(deps));
  const rest = await ctx.step.run('leftovers', async () => ({
    leftovers: await cleanLeftovers(deps),
    workspaces: deps.sweepWorkspaces(TREE_LEFTOVER_MS),
  }));
  const result = { ...clones, ...rest };
  deps.log.info(result, 'tree-cleanup done');
  return result;
}

async function cleanClones(deps: TreeCleanupDeps) {
  const cutoff = new Date(deps.now().getTime() - TREE_CLONE_KEEP_MS);
  const ids = (await list(deps.cacheDir)).flatMap((n) => {
    const m = /^([1-9]\d*)\.(git|graph)$/.exec(n);
    const id = m ? Number(m[1]) : NaN;
    return Number.isSafeInteger(id) ? [id] : [];
  });
  const unique = [...new Set(ids)];
  const out = { clones: unique.length, removed: 0, notViewed: 0, gone: 0, busy: 0 };
  if (!unique.length) return out;

  const [active, viewed] = await Promise.all([
    deps.activeRepos(unique),
    deps.viewedSince(cutoff).then((v) => new Set(v)),
  ]);
  const repoOf = new Map(active.map((r) => [r.githubRepoId, r.id]));
  for (const githubRepoId of unique) {
    const repoId = repoOf.get(githubRepoId);
    if (repoId) {
      if (viewed.has(repoId)) continue;
      // No view on record: count from when the clone was made, so a lost Redis (or a clone made
      // seconds ago) does not wipe the cache.
      if ((await clonedAt(deps.cacheDir, githubRepoId)) >= cutoff.getTime()) continue;
    }
    try {
      // Not waiting: a busy clone is being used right now; tomorrow's run looks again.
      await withRepoLock(deps.lock, githubRepoId, async () => {
        const dir = cloneDir(deps.cacheDir, githubRepoId);
        await rm(dir, { recursive: true, force: true });
        await rm(dir.replace(/\.git$/, '.graph'), { force: true });
      });
    } catch (err) {
      if (!(err instanceof RepoBusyError)) throw err;
      out.busy++;
      continue;
    }
    out.removed++;
    if (repoId) out.notViewed++;
    else out.gone++;
  }
  await deps.dropViewsBefore(cutoff);
  return out;
}

/** `<id>.git.tmp-*` (clone that never got renamed) and `<id>.graph.*.tmp` (graph write that died). */
async function cleanLeftovers(deps: TreeCleanupDeps): Promise<number> {
  const before = deps.now().getTime() - TREE_LEFTOVER_MS;
  let removed = 0;
  for (const name of await list(deps.cacheDir)) {
    if (!/^\d+\.(git\.tmp-[0-9a-f]+|graph\.[\d.]+\.tmp)$/.test(name)) continue;
    const p = path.join(deps.cacheDir, name);
    const at = await mtime(p);
    if (at === null || at >= before) continue;
    await rm(p, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** When the clone was made: git writes `HEAD` at clone time and a fetch leaves it alone. 0 = unknown. */
async function clonedAt(cacheDir: string, githubRepoId: number): Promise<number> {
  return (await mtime(path.join(cloneDir(cacheDir, githubRepoId), 'HEAD'))) ?? 0;
}

async function mtime(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // nothing cloned yet
    throw err;
  }
}

const IN_BATCH = 1000;

export const prismaActiveRepos: TreeCleanupDeps['activeRepos'] = async (githubRepoIds) => {
  const out: { id: string; githubRepoId: number }[] = [];
  for (let i = 0; i < githubRepoIds.length; i += IN_BATCH) {
    out.push(
      ...(await prisma.repo.findMany({
        where: { githubRepoId: { in: githubRepoIds.slice(i, i + IN_BATCH) }, active: true },
        select: { id: true, githubRepoId: true },
      })),
    );
  }
  return out;
};

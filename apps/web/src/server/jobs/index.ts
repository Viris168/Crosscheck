// Public entry for lane B (Jobs). Other lanes import `inngest` from '@/server/jobs' to send events.
import type { CommitGraph } from '@app/git-graph';
import type { TreeSyncReason } from '@app/shared';
import type { InngestFunction } from 'inngest';
import { env } from '@/server/env';
import { getRedis } from '@/server/redis';
import { inngest } from './client';
import {
  memberPrune,
  memberSync,
  reviewFinalize,
  reviewStart,
  reviewSweep,
  treeCleanup,
  treeCron,
  treeRefresh,
  treeSync,
} from './functions';
import { cloneDir, loadCloneGraph, type CacheRepo, type GraphHeads } from './repo-cache';
import { redisTreeRefreshState } from './tree-refresh';

export { inngest };

/** Registered Inngest functions, served by `/api/inngest`. */
export const functions: InngestFunction.Any[] = [
  reviewStart,
  reviewFinalize,
  reviewSweep,
  memberSync,
  memberPrune,
  treeSync,
  treeRefresh,
  treeCron,
  treeCleanup,
];

/**
 * Ask for a branch-tree sync (e.g. F calls this with 'first_view' when a repo has no `RepoGraph` yet).
 * The payload carries ids only. Duplicate requests are harmless: syncs run one per repo at a time.
 */
export async function requestTreeSync(
  repoId: string,
  orgId: string,
  reason: (typeof TreeSyncReason)[number],
): Promise<void> {
  await inngest.send({ name: 'tree/sync-requested', data: { repoId, orgId, reason } });
}

/**
 * Note that someone opened a repo's Branches page (GET `/api/repos/:repoId/tree` calls this).
 * `tree-cron` keeps only repos viewed in the last 7 days fresh, and `tree-cleanup` deletes clones not
 * viewed in 30 days. Best effort: never throws.
 */
export async function recordTreeView(repoId: string, at: Date = new Date()): Promise<void> {
  try {
    await redisTreeRefreshState(getRedis()).recordView(repoId, at);
  } catch {
    // Redis down: the next poll records it
  }
}

/** The commits-only clone of a repo. */
export const treeCloneDir = (githubRepoId: number): string =>
  cloneDir(env.REPO_CACHE_DIR, githubRepoId);

/** The commit graph the last sync stored for exactly these branch heads, or null (read the clone instead). */
export const loadTreeGraph = (repo: CacheRepo, heads: GraphHeads): Promise<CommitGraph | null> =>
  loadCloneGraph(repo, heads, { cacheDir: env.REPO_CACHE_DIR });

// Public entry for lane B (Jobs). Other lanes import `inngest` from '@/server/jobs' to send events.
import type { InngestFunction } from 'inngest';
import { getRedis } from '@/server/redis';
import { inngest } from './client';
import {
  memberPrune,
  memberSync,
  reviewFinalize,
  reviewStart,
  reviewSweep,
  treeCron,
  treeRefresh,
  treeSync,
} from './functions';
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
];

/**
 * Ask for a branch-tree sync (e.g. F calls this with 'first_view' when a repo has no `RepoGraph` yet).
 * The payload carries ids only. Duplicate requests are harmless: syncs run one per repo at a time.
 */
export async function requestTreeSync(
  repoId: string,
  orgId: string,
  reason: 'manual' | 'first_view' | 'webhook' | 'cron',
): Promise<void> {
  await inngest.send({ name: 'tree/sync-requested', data: { repoId, orgId, reason } });
}

/**
 * Note that someone opened a repo's Branches page (T5c's GET `/api/repos/:repoId/tree` calls this).
 * `tree-cron` keeps only repos viewed in the last 7 days fresh. Best effort: never throws.
 */
export async function recordTreeView(repoId: string, at: Date = new Date()): Promise<void> {
  await redisTreeRefreshState(getRedis())
    .recordView(repoId, at)
    .catch(() => {});
}

// Public entry for lane B (Jobs). Other lanes import `inngest` from '@/server/jobs' to send events.
import type { InngestFunction } from 'inngest';
import { inngest } from './client';
import {
  memberPrune,
  memberSync,
  reviewFinalize,
  reviewStart,
  reviewSweep,
  treeSync,
} from './functions';

export { inngest };

/** Registered Inngest functions, served by `/api/inngest`. */
export const functions: InngestFunction.Any[] = [
  reviewStart,
  reviewFinalize,
  reviewSweep,
  memberSync,
  memberPrune,
  treeSync,
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

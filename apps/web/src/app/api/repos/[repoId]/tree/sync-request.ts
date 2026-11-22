import 'server-only';
import type { TreeSyncReason } from '@app/shared';
import { requestTreeSync } from '@/server/jobs';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';

/** Manual "Refresh": one per repo per minute. */
export const SYNC_RATE_WINDOW_SECONDS = 60;
/**
 * First view without a graph: send once, then again only if nothing showed up after 5 min.
 * VERIFY: 5 min is long enough for T2c to create the RepoGraph row on a large first clone.
 */
export const FIRST_VIEW_WINDOW_SECONDS = 300;

/**
 * Takes a per-repo Redis slot (`SET NX EX`). True when this caller got it. If Redis is down we let
 * the request through: the sync job runs one at a time per repo (Inngest concurrency key), so an
 * extra event costs one queued run, not a second clone.
 */
export async function takeSlot(key: string, seconds: number): Promise<boolean> {
  try {
    // VERIFY: ioredis `SET key v EX s NX` resolves 'OK' when set and null when the key exists.
    return (await getRedis().set(key, '1', 'EX', seconds, 'NX')) === 'OK';
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'tree rate limit unavailable',
    );
    return true;
  }
}

/** Gives the slot back (the event could not be sent), so the next try is not rate limited. */
export async function releaseSlot(key: string): Promise<void> {
  await getRedis()
    .del(key)
    .catch(() => undefined);
}

/** Sends the event inside the slot; frees the slot if sending fails, then rethrows. */
export async function requestInSlot(key: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (err) {
    await releaseSlot(key);
    throw err;
  }
}

export const syncKey = (repoId: string) => `tree:sync:rl:${repoId}`;
export const firstViewKey = (repoId: string) => `tree:first-view:${repoId}`;

/** Sends `tree/sync-requested` (ids only in the payload) and logs it. */
export async function startTreeSync(
  repoId: string,
  orgId: string,
  reason: (typeof TreeSyncReason)[number],
) {
  await requestTreeSync(repoId, orgId, reason);
  logger.info({ repoId, reason }, 'tree sync requested');
}

import { HttpError, SyncOrgsResponse } from '@app/shared';
import { json, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { syncUserMemberships } from '@/server/github';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

const SYNC_ORGS_LIMIT = 5;
const SYNC_ORGS_WINDOW_SECONDS = 60;

/**
 * Fixed 60s window per user. If Redis is unavailable we let the request through: the caller is
 * signed in, the sync is idempotent, and it never grants access on a GitHub error.
 */
async function allowSync(userId: string): Promise<boolean> {
  const key = `rl:sync-orgs:${userId}`;
  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, SYNC_ORGS_WINDOW_SECONDS);
    return count <= SYNC_ORGS_LIMIT;
  } catch (err) {
    logger.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'sync-orgs rate limit unavailable',
    );
    return true;
  }
}

/** POST /api/me/sync-orgs — re-checks the signed-in user's GitHub memberships ("Check again"). */
export const POST = route(async (req) => {
  const session = await requireSession(req);
  const userId = session.user.id;
  if (!(await allowSync(userId))) {
    throw new HttpError('rate_limited', 'Too many checks. Try again in a minute.');
  }
  const result = await syncUserMemberships(userId);
  return json(SyncOrgsResponse, result);
});

import 'server-only';
import { getRedis } from '@/server/redis';
import { logger } from '@/server/logger';

export const INGEST_RATE_LIMIT = 30;
export const INGEST_RATE_WINDOW_SECONDS = 3600;

/**
 * Fixed one-hour window per ingest token (keyed by the token's hash, never the token).
 * Returns false when the caller is over the limit. If Redis is unavailable we let the request
 * through: the endpoint is already authenticated and idempotent, and failing closed would drop
 * legitimate Action results.
 */
export async function allowIngest(tokenHash: string, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 1000 / INGEST_RATE_WINDOW_SECONDS);
  const key = `ingest:rl:${tokenHash}:${window}`;
  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, INGEST_RATE_WINDOW_SECONDS);
    return count <= INGEST_RATE_LIMIT;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ingest rate limit unavailable');
    return true;
  }
}

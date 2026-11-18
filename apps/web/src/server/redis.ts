import 'server-only';
import { Redis } from 'ioredis';
import { env } from './env';
import { logger } from './logger';

// One shared ioredis client per process (webhook dedupe, rate limits). Created on first use.
const globalForRedis = globalThis as unknown as { redis?: Redis };

export function getRedis(): Redis {
  if (globalForRedis.redis) return globalForRedis.redis;
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  client.on('error', (err: Error) => logger.error({ err: err.message }, 'redis error'));
  globalForRedis.redis = client;
  return client;
}

/** Closes the shared client (tests / graceful shutdown). */
export async function closeRedis(): Promise<void> {
  const client = globalForRedis.redis;
  globalForRedis.redis = undefined;
  if (client) await client.quit().catch(() => client.disconnect());
}

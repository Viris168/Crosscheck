import 'server-only';
import { verifyWebhookSignature } from '@app/github';
import { errorBody } from '@app/shared';
import { z } from 'zod';
import { env } from '@/server/env';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';
import {
  handleInstallation,
  handleInstallationRepositories,
  handleIssueComment,
  handlePullRequest,
  type HandlerResult,
} from './handlers';

/** Deliveries we've seen are remembered this long (GitHub redelivers within hours). */
export const DELIVERY_TTL_SECONDS = 24 * 60 * 60;
const deliveryKey = (id: string) => `gh:delivery:${id}`;

const HANDLERS: Record<string, (body: unknown) => Promise<HandlerResult>> = {
  installation: handleInstallation,
  installation_repositories: handleInstallationRepositories,
  pull_request: handlePullRequest,
  issue_comment: handleIssueComment,
};

/**
 * Claims a delivery id (Redis `SET NX EX`). Returns false if it was already processed.
 * If Redis is down we still process: Review creation is idempotent at the DB level.
 */
async function claimDelivery(id: string): Promise<boolean> {
  try {
    const res = await getRedis().set(deliveryKey(id), '1', 'EX', DELIVERY_TTL_SECONDS, 'NX');
    return res === 'OK';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'webhook dedupe unavailable; processing anyway');
    return true;
  }
}

async function releaseDelivery(id: string): Promise<void> {
  await getRedis()
    .del(deliveryKey(id))
    .catch(() => undefined);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * POST /api/webhooks/github. Verifies the HMAC on the raw body, dedupes by delivery id, then does
 * only DB upserts + `inngest.send` (heavy work runs in Inngest functions).
 */
export async function handleGithubWebhook(req: Request): Promise<Response> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('GITHUB_WEBHOOK_SECRET is not set; rejecting webhook');
    return json(errorBody('internal', 'Webhook secret not configured'), 500);
  }

  // Raw body first: the signature is over the exact bytes GitHub sent.
  const raw = await req.text();
  if (
    !verifyWebhookSignature(
      Buffer.from(raw, 'utf8'),
      req.headers.get('x-hub-signature-256'),
      secret,
    )
  ) {
    return json(errorBody('unauthorized', 'Invalid signature'), 401);
  }

  const event = req.headers.get('x-github-event') ?? '';
  const deliveryId = req.headers.get('x-github-delivery') ?? '';
  if (!event || !deliveryId) {
    return json(errorBody('bad_request', 'Missing X-GitHub-Event or X-GitHub-Delivery'), 400);
  }

  const handler = HANDLERS[event];
  if (!handler) return json({ ok: true, ignored: event });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(errorBody('bad_request', 'Body is not JSON'), 400);
  }

  if (!(await claimDelivery(deliveryId))) {
    logger.info({ deliveryId, event }, 'duplicate webhook delivery ignored');
    return json({ ok: true, duplicate: true });
  }

  const log = logger.child({ deliveryId, event });
  try {
    const result = await handler(body);
    log.info({ ...result }, 'webhook handled');
    return json({ ok: true, ...result });
  } catch (err) {
    // Let a GitHub redelivery try again.
    await releaseDelivery(deliveryId);
    if (err instanceof z.ZodError) {
      log.warn({ issues: err.issues.length }, 'webhook payload rejected');
      return json(errorBody('bad_request', 'Unexpected payload shape'), 400);
    }
    log.error({ err: (err as Error).message }, 'webhook handler failed');
    return json(errorBody('internal', 'Internal server error'), 500);
  }
}

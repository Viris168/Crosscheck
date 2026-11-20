// Inngest function definitions. Handlers live in review-*.ts and take their dependencies explicitly.
import { LIMITS, REVIEW_SWEEP_CRON } from '@app/shared';
import { pruneRemovedMembers, syncUserMemberships } from '@/server/github';
import { logger } from '@/server/logger';
import { inngest } from './client';
import { realDeps, type JobDeps, type StepTools } from './deps';
import { MEMBER_PRUNE_CRON, memberPruneHandler } from './member-prune';
import { memberSyncHandler } from './member-sync';
import { reviewFinalizeHandler } from './review-finalize';
import { reviewStartHandler } from './review-start';
import { reviewSweepHandler } from './review-sweep';

let deps: JobDeps | undefined;
const getDeps = (): JobDeps => (deps ??= realDeps());

// Inngest's `step.run` returns `Jsonify<T>`; our step outputs are plain JSON, so `StepTools` matches.
const tools = (step: unknown): StepTools => step as StepTools;

/**
 * `retries: 2` = up to 2 retries per step (timeout / rate_limited / github_error).
 * invalid_output gets one retry and provider_auth none, via NonRetriableError (see errors.ts).
 * VERIFY: inngest v3 applies the function's `retries` to each step independently.
 */
export const reviewStart = inngest.createFunction(
  {
    id: 'review-start',
    retries: 2,
    concurrency: { key: 'event.data.orgId', limit: LIMITS.reviewsPerOrgConcurrency },
  },
  { event: 'review/requested' },
  ({ event, step, attempt }) =>
    reviewStartHandler({ event, step: tools(step), attempt }, getDeps()),
);

export const reviewFinalize = inngest.createFunction(
  {
    id: 'review-finalize',
    retries: 2,
    // One finalize per review at a time (ingest + a duplicate event must not post twice).
    concurrency: { key: 'event.data.reviewId', limit: 1 },
  },
  { event: 'review/finalize' },
  ({ event, step, attempt }) =>
    reviewFinalizeHandler({ event, step: tools(step), attempt }, getDeps()),
);

export const reviewSweep = inngest.createFunction(
  { id: 'review-sweep', retries: 2 },
  { cron: REVIEW_SWEEP_CRON },
  ({ step }) => reviewSweepHandler({ step: tools(step) }, getDeps()),
);

/**
 * Syncs a user's org memberships with GitHub after sign-in. One sync per user at a time;
 * default retries (the sync is idempotent).
 * VERIFY: with no `retries` set, inngest v3 retries a failed step 3 times (4 attempts).
 */
export const memberSync = inngest.createFunction(
  { id: 'member-sync', concurrency: { key: 'event.data.userId', limit: 1 } },
  { event: 'user/signed-in' },
  ({ event, step }) =>
    memberSyncHandler({ event, step: tools(step) }, { sync: syncUserMemberships, log: logger }),
);

/**
 * Every 30 minutes, removes memberships GitHub no longer backs (removals only). One run at a time.
 * VERIFY: with no `retries` set, inngest v3 retries a failed step 3 times (4 attempts).
 */
export const memberPrune = inngest.createFunction(
  { id: 'member-prune', concurrency: { limit: 1 } },
  { cron: MEMBER_PRUNE_CRON },
  ({ step }) =>
    memberPruneHandler({ step: tools(step) }, { prune: pruneRemovedMembers, log: logger }),
);

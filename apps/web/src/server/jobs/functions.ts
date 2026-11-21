// Inngest function definitions. Handlers live in review-*.ts and take their dependencies explicitly.
import { LIMITS, REVIEW_SWEEP_CRON } from '@app/shared';
import { pruneRemovedMembers, syncUserMemberships } from '@/server/github';
import { env } from '@/server/env';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';
import { inngest } from './client';
import { realDeps, realTreeSyncDeps, type JobDeps, type StepTools } from './deps';
import { MEMBER_PRUNE_CRON, memberPruneHandler } from './member-prune';
import { memberSyncHandler } from './member-sync';
import { reviewFinalizeHandler } from './review-finalize';
import { reviewStartHandler } from './review-start';
import { reviewSweepHandler } from './review-sweep';
import { redisRepoLock } from './repo-cache';
import {
  TREE_CRON,
  fetchCloneRefs,
  prismaTreeRefreshStore,
  redisTreeRefreshState,
  treeCronHandler,
  treeRefreshHandler,
  type TreeRefreshDeps,
  type TreeRefreshStep,
} from './tree-refresh';
import { treeSyncHandler, type TreeSyncDeps, type TreeSyncStep } from './tree-sync';

let deps: JobDeps | undefined;
const getDeps = (): JobDeps => (deps ??= realDeps());
let treeDeps: TreeSyncDeps | undefined;
const getTreeDeps = (): TreeSyncDeps => (treeDeps ??= realTreeSyncDeps());
let refreshDeps: TreeRefreshDeps | undefined;
const getRefreshDeps = (): TreeRefreshDeps => (refreshDeps ??= realTreeRefreshDeps());

/** Wait this long for the clone lock (a full sync may hold it) before the step gives up and retries. */
const REFRESH_LOCK_WAIT_MS = 30_000;

function realTreeRefreshDeps(): TreeRefreshDeps {
  const redis = getRedis();
  const lock = redisRepoLock(redis);
  return {
    sync: getTreeDeps(),
    store: prismaTreeRefreshStore,
    state: redisTreeRefreshState(redis),
    refs: {
      fetchRefs: (repo, auth, refs) =>
        fetchCloneRefs(repo, auth, refs, {
          cacheDir: env.REPO_CACHE_DIR,
          lock,
          lockWaitMs: REFRESH_LOCK_WAIT_MS,
          assertNoContents: process.env.TREE_ASSERT_NO_CONTENTS === '1',
        }),
    },
  };
}

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

/**
 * Branch tree: refresh refs, PRs, CI and the commits-only clone, then write the snapshot.
 * One sync per repo at a time (the clone is also guarded by a Redis lock) and at most 2 per org.
 * VERIFY: inngest v3 accepts an array of two concurrency limits and applies both.
 */
export const treeSync = inngest.createFunction(
  {
    id: 'tree-sync',
    retries: 2,
    concurrency: [
      { key: 'event.data.repoId', limit: 1 },
      { key: 'event.data.orgId', limit: 2 },
    ],
  },
  { event: 'tree/sync-requested' },
  ({ event, step }) =>
    treeSyncHandler({ event, step: step as unknown as TreeSyncStep }, getTreeDeps()),
);

/**
 * Branch tree, live (T5b): apply the new `GitEvent`s, fetch only the touched refs, rebuild the snapshot.
 * Debounced per repo (a burst of pushes → one run, with the last event), one run per repo at a time.
 * VERIFY: inngest v3 `debounce: { key, period, timeout }` runs once with the last event of the window,
 * and combines with `concurrency` (a debounced run waits for the running one).
 */
export const treeRefresh = inngest.createFunction(
  {
    id: 'tree-refresh',
    retries: 2,
    debounce: { key: 'event.data.repoId', period: '2s', timeout: '10s' },
    concurrency: { key: 'event.data.repoId', limit: 1 },
  },
  { event: 'tree/refs-changed' },
  ({ event, step }) =>
    treeRefreshHandler({ event, step: step as unknown as TreeRefreshStep }, getRefreshDeps()),
);

/**
 * Every 15 min: full sync for repos whose tree is older than 15 min and was viewed in the last 7 days
 * (views tracked in Redis by `recordTreeView`). One run at a time.
 */
export const treeCron = inngest.createFunction(
  { id: 'tree-cron', retries: 2, concurrency: { limit: 1 } },
  { cron: TREE_CRON },
  ({ step }) => {
    const d = getRefreshDeps();
    return treeCronHandler(
      { step: step as unknown as TreeRefreshStep },
      { store: d.store, state: d.state, now: () => new Date(), log: logger },
    );
  },
);

// tree-refresh (`tree/refs-changed`, T5b): apply the `GitEvent`s T5a recorded since the last refresh, fetch
// only the touched refs into the commits-only clone, and rebuild the snapshot with tree-sync's steps.
// Also: recorded parents for new branches, and the `tree-cron` fallback for repos without live events.
// Privacy: step outputs carry ids, counts and SHAs only. Branch names never leave a step: each step that
// needs them re-reads the same (immutable) event range from the DB.
import { stat } from 'node:fs/promises';
import { prisma } from '@app/db';
import { runGit } from '@app/git-graph/git';
import type { EventData } from '@app/shared';
import type { JobLogger } from './deps';
import { errorCodeOf, errorMessageOf, nonRetriable } from './errors';
import {
  assertNoContents,
  cloneDir,
  lockDown,
  withRepoLock,
  type CacheRepo,
  type GitAuth,
  type RepoLock,
} from './repo-cache';
import {
  githubCall,
  planPrs,
  rebuildSnapshotSteps,
  type TreeRepo,
  type TreeSyncDeps,
  type TreeSyncStep,
} from './tree-sync';

// --- contracts ---

/** A `GitEvent` row (T5a writes them; refs and SHAs only). */
export interface GitEventRow {
  id: string;
  /** 'push' | 'branch_created' | 'branch_deleted' | 'force_push' | 'pull_request' | 'ci' */
  kind: string;
  ref: string | null;
  before: string | null;
  after: string | null;
  prNumber: number | null;
  receivedAt: Date;
}

/** Position in a repo's event stream: events are ordered by `(receivedAt, id)`. */
export interface RefreshCursor {
  at: string; // ISO
  id: string;
}

/** The events one refresh handles: after `after` (or since `since` when there is no cursor), up to `upTo`. */
export interface EventRange {
  after: RefreshCursor | null;
  since: string | null;
  upTo: RefreshCursor;
}

export interface BranchRow {
  name: string;
  headSha: string;
  isDefault: boolean;
  deletedAt: Date | null;
  recordedAt: Date | null;
}

export interface TreeRefreshStore {
  graphState(repoId: string): Promise<{ syncedAt: Date | null; hasSnapshot: boolean } | null>;
  /** Ordered by `(receivedAt, id)`, at most `limit`. */
  gitEvents(
    repoId: string,
    range: {
      after: RefreshCursor | null;
      since: Date | null;
      upTo: RefreshCursor | null;
      limit: number;
    },
  ): Promise<GitEventRow[]>;
  /** Every branch row, deleted ones too. */
  branchRows(repoId: string): Promise<BranchRow[]>;
  applyRefresh(repoId: string, plan: RefreshPlan, now: Date): Promise<void>;
  /** Active repos among `repoIds` whose graph has not synced since `cutoff` (or never). */
  staleRepos(
    repoIds: readonly string[],
    cutoff: Date,
    limit: number,
  ): Promise<{ repoId: string; orgId: string }[]>;
}

/** Redis: the refresh cursor per repo and when each repo's tree was last viewed. */
export interface TreeRefreshState {
  getCursor(repoId: string): Promise<RefreshCursor | null>;
  setCursor(repoId: string, cursor: RefreshCursor): Promise<void>;
  recordView(repoId: string, at: Date): Promise<void>;
  /** repoIds viewed at or after `since`. */
  viewedSince(since: Date): Promise<string[]>;
  /** Forget views older than `before` (tree-cleanup; the cron and the cleanup read different windows). */
  dropViewsBefore(before: Date): Promise<void>;
}

export interface TreeRefreshRefs {
  /**
   * `git fetch` only `fetch` (`+refs/heads/x:refs/heads/x`) and `update-ref -d` each of `remove`, under the
   * clone lock. `no_clone` = there is no clone yet (the caller clones).
   */
  fetchRefs(
    repo: CacheRepo,
    auth: GitAuth,
    refs: { fetch: readonly string[]; remove: readonly string[] },
  ): Promise<'fetched' | 'no_clone'>;
}

export interface TreeRefreshDeps {
  /** tree-sync's deps: repo lookup, branch/PR store, GitHub reads, clone, merged cache, snapshot */
  sync: TreeSyncDeps;
  store: TreeRefreshStore;
  state: TreeRefreshState;
  refs: TreeRefreshRefs;
}

type TreeEventPayload =
  | { name: 'tree/sync-requested'; data: EventData<'tree/sync-requested'> }
  | { name: 'tree/refs-changed'; data: EventData<'tree/refs-changed'> };

export interface TreeRefreshStep extends TreeSyncStep {
  sendEvent(id: string, payload: TreeEventPayload | TreeEventPayload[]): Promise<unknown>;
}

export type TreeRefreshResult =
  | { status: 'ready'; events: number; branches: number; commits: number }
  | { status: 'skipped'; reason: 'repo_missing' | 'no_events' }
  | { status: 'full_sync'; events: number; reason: 'no_snapshot' | 'default_force_push' | 'error' };

/** Events handled per run; more → the run sends `tree/refs-changed` again to continue. */
export const REFRESH_MAX_EVENTS = 1000;
/** Without a cursor (Redis lost it), re-read events from this long before the last full sync. */
const NO_CURSOR_MARGIN_MS = 60_000;
/** Heads the `ci` step looks at per refresh. */
const REFRESH_MAX_CI = 200;

// --- tree-refresh ---

export async function treeRefreshHandler(
  ctx: { event: { data: EventData<'tree/refs-changed'> }; step: TreeRefreshStep },
  deps: TreeRefreshDeps,
): Promise<TreeRefreshResult> {
  const { repoId, orgId } = ctx.event.data;
  const { step } = ctx;
  const { sync, store, state } = deps;
  const log = sync.log;
  const fullSync = () =>
    step.sendEvent('request-full-sync', {
      name: 'tree/sync-requested',
      data: { repoId, orgId, reason: 'webhook' },
    });
  const advance = (range: EventRange) =>
    step.run('advance-cursor', async () => {
      await state.setCursor(repoId, range.upTo);
      return { ok: true };
    });

  let applied: Extract<Awaited<ReturnType<typeof applyEvents>>, { status: 'applied' }> | null =
    null;
  try {
    const out = await step.run('apply-events', () => applyEvents(repoId, deps));
    if (out.status === 'repo_missing') {
      log.warn({ repoId }, 'tree-refresh skipped: repo missing or inactive');
      return { status: 'skipped', reason: 'repo_missing' };
    }
    if (out.status === 'no_events') return { status: 'skipped', reason: 'no_events' };
    applied = out;
    const { range } = out;

    if (out.full) {
      // No snapshot yet, or the default branch was force-pushed: the full sync is the fallback.
      await fullSync();
      await advance(range);
      const reason = out.hasSnapshot ? 'default_force_push' : 'no_snapshot';
      log.info({ repoId, events: out.events, reason }, 'tree-refresh: full sync requested');
      return { status: 'full_sync', events: out.events, reason };
    }

    if (out.prs) {
      await step.run('prs', async () => {
        const repo = await loadRepo(sync, repoId);
        const prs = await githubCall(
          () => sync.github.listPullRequests(repo),
          'pull request list failed',
        );
        const plan = planPrs(
          await sync.store.existingPrs(
            repoId,
            prs.map((p) => p.number),
          ),
          prs,
        );
        await sync.store.applyPrs(repoId, plan);
        return { prs: prs.length, created: plan.create.length, updated: plan.update.length };
      });
    }

    if (out.fetch) {
      await step.run('fetch-refs', async () => {
        const events = await store.gitEvents(repoId, {
          after: range.after,
          since: range.since ? new Date(range.since) : null,
          upTo: range.upTo,
          limit: REFRESH_MAX_EVENTS,
        });
        const { upsert, remove } = planRefresh([], events);
        const repo = await loadRepo(sync, repoId);
        const auth = await githubCall(() => sync.github.gitAuth(repo), 'git token failed');
        const fetchNames = upsert.map((u) => u.name);
        let fallback = false;
        try {
          const res = await deps.refs.fetchRefs(repo, auth, { fetch: fetchNames, remove });
          fallback = res === 'no_clone';
        } catch (err) {
          // e.g. a ref deleted again before we fetched it: a full fetch (with --prune) settles it.
          log.warn(
            { repoId, errorCode: errorCodeOf(err) },
            'tree-refresh: ref fetch failed, fetching all',
          );
          fallback = true;
        }
        if (fallback) await sync.cache.ensureClone(repo, auth);
        return { fetched: fetchNames.length, removed: remove.length, fullFetch: fallback };
      });
    }

    const snap = await rebuildSnapshotSteps(step, sync, repoId, {
      only: out.ciShas,
      force: out.ciForce,
      snapshotFirst: true,
    });
    await advance(range);
    if (out.more) {
      await step.sendEvent('continue', {
        name: 'tree/refs-changed',
        data: { repoId, orgId, eventId: range.upTo.id },
      });
    }
    log.info({ repoId, events: out.events, ...snap }, 'tree-refresh done');
    return {
      status: 'ready',
      events: out.events,
      branches: snap.branches,
      commits: snap.commits,
    };
  } catch (err) {
    // Any failure: hand the repo to the full sync (it re-lists everything). Recorded parents written by
    // `apply-events` stay; if that step itself failed, the cursor stays put and the events are re-read.
    log.error(
      { repoId, errorCode: errorCodeOf(err), err: errorMessageOf(err) },
      'tree-refresh failed, requesting a full sync',
    );
    await fullSync();
    if (applied) await advance(applied.range);
    return { status: 'full_sync', events: applied?.events ?? 0, reason: 'error' };
  }
}

/** Step `apply-events`: read the new events, update only the touched `Branch` rows (+ recorded parents). */
async function applyEvents(repoId: string, deps: TreeRefreshDeps) {
  const { sync, store, state } = deps;
  const repo = await sync.store.getRepo(repoId);
  if (!repo || !repo.active) return { status: 'repo_missing' as const };
  const [graph, cursor] = await Promise.all([store.graphState(repoId), state.getCursor(repoId)]);
  const since =
    !cursor && graph?.syncedAt ? new Date(graph.syncedAt.getTime() - NO_CURSOR_MARGIN_MS) : null;
  const events = await store.gitEvents(repoId, {
    after: cursor,
    since,
    upTo: null,
    limit: REFRESH_MAX_EVENTS,
  });
  const last = events.at(-1);
  if (!last) return { status: 'no_events' as const };
  const plan = planRefresh(await store.branchRows(repoId), events);
  await store.applyRefresh(repoId, plan, sync.now());
  const range: EventRange = {
    after: cursor,
    since: since?.toISOString() ?? null,
    upTo: { at: last.receivedAt.toISOString(), id: last.id },
  };
  const hasSnapshot = graph?.hasSnapshot ?? false;
  return {
    status: 'applied' as const,
    range,
    events: events.length,
    more: events.length === REFRESH_MAX_EVENTS,
    hasSnapshot,
    full: plan.fullSync || !hasSnapshot,
    prs: plan.prs,
    fetch: plan.upsert.length + plan.remove.length > 0,
    // SHAs only (allowed in step outputs): the heads the `ci` step looks at.
    ciShas: unique([...plan.upsert.map((u) => u.headSha), ...plan.ciForce]).slice(
      0,
      REFRESH_MAX_CI,
    ),
    ciForce: plan.ciForce.slice(0, REFRESH_MAX_CI),
    upserted: plan.upsert.length,
    removed: plan.remove.length,
    recorded: plan.upsert.filter((u) => u.record).length,
    skippedEvents: plan.skipped,
  };
}

async function loadRepo(sync: TreeSyncDeps, repoId: string): Promise<TreeRepo> {
  const repo = await sync.store.getRepo(repoId);
  if (!repo || !repo.active) throw nonRetriable('internal', 'repo missing or inactive');
  return repo;
}

// --- planning (pure) ---

export interface RefreshPlan {
  /** branches created or moved, in their final state */
  upsert: {
    name: string;
    headSha: string;
    /** no live row before (new, or re-created after a delete): reset what was recorded */
    fresh: boolean;
    /** recorded parents to store, or null = leave `recordedParents` / `recordedAt` alone */
    record: string[] | null;
  }[];
  /** branches deleted (soft-delete the row, `update-ref -d` in the clone) */
  remove: string[];
  /** SHAs a CI event reported on: re-fetch their CI even if cached as terminal */
  ciForce: string[];
  /** a pull_request event: re-read PRs */
  prs: boolean;
  /** the default branch was force-pushed: full sync */
  fullSync: boolean;
  /** events ignored (tag refs, bad SHAs, unknown kinds) */
  skipped: number;
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ZERO_SHA_RE = /^0+$/;

/**
 * Replay `events` (oldest first) over the branch rows. Recorded parents (prototype `actions.branch`): on
 * `branch_created` with `after = X`, every other branch whose head is `X` at that moment, sorted. Zero
 * matches → `[]` (the engine infers). A branch that already has `recordedAt` is never re-recorded.
 */
export function planRefresh(
  rows: readonly BranchRow[],
  events: readonly GitEventRow[],
): RefreshPlan {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const heads = new Map(rows.filter((r) => !r.deletedAt).map((r) => [r.name, r.headSha]));
  const touched = new Map<string, RefreshPlan['upsert'][number]>();
  const removed = new Set<string>();
  const ciForce = new Set<string>();
  const plan: RefreshPlan = {
    upsert: [],
    remove: [],
    ciForce: [],
    prs: false,
    fullSync: false,
    skipped: 0,
  };

  for (const e of events) {
    if (e.kind === 'pull_request') {
      plan.prs = true;
      continue;
    }
    if (e.kind === 'ci') {
      if (e.after && SHA_RE.test(e.after)) ciForce.add(e.after);
      else plan.skipped++;
      continue;
    }
    const name = branchName(e.ref);
    if (!name) {
      plan.skipped++;
      continue;
    }
    if (e.kind === 'branch_deleted') {
      heads.delete(name);
      touched.delete(name);
      removed.add(name);
      continue;
    }
    if (e.kind !== 'push' && e.kind !== 'force_push' && e.kind !== 'branch_created') {
      plan.skipped++;
      continue;
    }
    const after = e.after;
    if (!after || !SHA_RE.test(after) || ZERO_SHA_RE.test(after)) {
      plan.skipped++;
      continue;
    }
    const row = byName.get(name);
    if (e.kind === 'force_push' && row?.isDefault && !row.deletedAt) plan.fullSync = true;
    const prev = touched.get(name);
    const recreated = removed.delete(name);
    const fresh = recreated || (prev ? prev.fresh : !row || !!row.deletedAt);
    let record = recreated ? null : (prev?.record ?? null);
    if (e.kind === 'branch_created' && record === null && (fresh || row?.recordedAt == null)) {
      record = [...heads]
        .filter(([n, sha]) => n !== name && sha === after)
        .map(([n]) => n)
        .sort();
    }
    heads.set(name, after);
    touched.set(name, { name, headSha: after, fresh, record });
  }

  plan.upsert = [...touched.values()];
  plan.remove = [...removed];
  plan.ciForce = [...ciForce];
  return plan;
}

/** `refs/heads/x` or `x` → `x`; tags, other refs and names git would reject → null. */
export function branchName(ref: string | null): string | null {
  if (!ref) return null;
  let name = ref;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  else if (name.startsWith('refs/')) return null;
  return isSafeBranchName(name) ? name : null;
}

/** `git check-ref-format` rules for a branch name, so it can go into a refspec safely. */
export function isSafeBranchName(n: string): boolean {
  if (!n || n.length > 255 || n === '@' || n === 'HEAD') return false;
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(n)) return false;
  if (n.includes('..') || n.includes('@{') || n.includes('//')) return false;
  return n.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.lock'));
}

// --- tree-cron ---

export const TREE_CRON = '*/15 * * * *';
/** A repo is stale when its last sync is older than this. */
export const TREE_STALE_MS = 15 * 60_000;
/** Only repos whose tree page was viewed this recently are kept fresh by the cron. */
export const TREE_VIEW_WINDOW_MS = 7 * 24 * 60 * 60_000;
const CRON_MAX_REPOS = 500;

/**
 * Every 15 min: `tree/sync-requested` (`cron`) for repos whose sync is older than 15 min and whose tree
 * was viewed in the last 7 days. Views are tracked in Redis (`recordTreeView`), not `RepoGraph.updatedAt`:
 * every sync (the cron's own included) bumps `updatedAt`, so it can't tell a viewed repo from a synced one.
 */
export async function treeCronHandler(
  ctx: { step: TreeRefreshStep },
  deps: { store: TreeRefreshStore; state: TreeRefreshState; now(): Date; log: JobLogger },
): Promise<{ requested: number }> {
  const { step } = ctx;
  const due = await step.run('find-stale', async () => {
    const now = deps.now().getTime();
    const viewed = await deps.state.viewedSince(new Date(now - TREE_VIEW_WINDOW_MS));
    if (!viewed.length) return [];
    return deps.store.staleRepos(viewed, new Date(now - TREE_STALE_MS), CRON_MAX_REPOS);
  });
  if (due.length) {
    await step.sendEvent(
      'request-syncs',
      due.map((r) => ({
        name: 'tree/sync-requested' as const,
        data: { repoId: r.repoId, orgId: r.orgId, reason: 'cron' as const },
      })),
    );
    deps.log.info({ requested: due.length }, 'tree-cron: syncs requested');
  }
  return { requested: due.length };
}

// --- git: fetch only the touched refs ---

const FETCH_BATCH = 100;

export interface FetchRefsOptions {
  cacheDir: string;
  lock: RepoLock;
  lockWaitMs?: number;
  assertNoContents?: boolean;
  timeoutMs?: number;
}

/**
 * Fetch only `refs.fetch` into the commits-only clone (`--filter=tree:0`, forced refspecs so force-pushes
 * apply) and delete `refs.remove`. Same lock-down as `ensureClone`: after the fetch origin is made a
 * non-promisor remote again, so nothing is ever lazily fetched into the cache.
 */
export async function fetchCloneRefs(
  repo: CacheRepo,
  auth: GitAuth,
  refs: { fetch: readonly string[]; remove: readonly string[] },
  opts: FetchRefsOptions,
): Promise<'fetched' | 'no_clone'> {
  const gitDir = cloneDir(opts.cacheDir, repo.githubRepoId);
  const fetch = refs.fetch.filter(isSafeBranchName);
  const remove = refs.remove.filter(isSafeBranchName);
  return withRepoLock(
    opts.lock,
    repo.githubRepoId,
    async () => {
      if (!(await exists(gitDir))) return 'no_clone' as const;
      for (const name of remove) {
        // exit 1 when the ref is already gone: fine
        await runGit(['--git-dir', gitDir, 'update-ref', '-d', `refs/heads/${name}`], {
          okExitCodes: [0, 1],
        });
      }
      if (fetch.length) {
        await runGit(['--git-dir', gitDir, 'config', 'remote.origin.url', auth.url]);
        try {
          for (let i = 0; i < fetch.length; i += FETCH_BATCH) {
            await runGit(
              [
                '--git-dir',
                gitDir,
                'fetch',
                '--filter=tree:0',
                '--no-tags',
                '--quiet',
                'origin',
                ...fetch.slice(i, i + FETCH_BATCH).map((n) => `+refs/heads/${n}:refs/heads/${n}`),
              ],
              { env: auth.env, timeoutMs: opts.timeoutMs },
            );
          }
        } finally {
          await lockDown(gitDir).catch(() => {});
        }
      }
      if (opts.assertNoContents) await assertNoContents(gitDir);
      return 'fetched' as const;
    },
    { waitMs: opts.lockWaitMs },
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// --- Prisma store ---

const IN_BATCH = 1000;

export const prismaTreeRefreshStore: TreeRefreshStore = {
  async graphState(repoId) {
    const g = await prisma.repoGraph.findUnique({
      where: { repoId },
      select: { syncedAt: true, snapshot: true },
    });
    return g ? { syncedAt: g.syncedAt, hasSnapshot: g.snapshot !== null } : null;
  },

  gitEvents(repoId, { after, since, upTo, limit }) {
    const and: object[] = [];
    if (after) {
      const at = new Date(after.at);
      and.push({ OR: [{ receivedAt: { gt: at } }, { receivedAt: at, id: { gt: after.id } }] });
    } else if (since) {
      and.push({ receivedAt: { gte: since } });
    }
    if (upTo) {
      const at = new Date(upTo.at);
      and.push({ OR: [{ receivedAt: { lt: at } }, { receivedAt: at, id: { lte: upTo.id } }] });
    }
    return prisma.gitEvent.findMany({
      where: { repoId, AND: and },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        kind: true,
        ref: true,
        before: true,
        after: true,
        prNumber: true,
        receivedAt: true,
      },
    });
  },

  branchRows(repoId) {
    return prisma.branch.findMany({
      where: { repoId },
      select: { name: true, headSha: true, isDefault: true, deletedAt: true, recordedAt: true },
    });
  },

  async applyRefresh(repoId, plan, now) {
    for (const u of plan.upsert) {
      const recorded = u.record
        ? { recordedParents: u.record, recordedAt: now }
        : { recordedParents: [], recordedAt: null };
      await prisma.branch.upsert({
        where: { repoId_name: { repoId, name: u.name } },
        create: { repoId, name: u.name, headSha: u.headSha, ...recorded },
        update: {
          headSha: u.headSha,
          deletedAt: null,
          // A re-created branch is a new branch: forget (or replace) what was recorded.
          ...(u.fresh ? { ...recorded, isDefault: false } : {}),
        },
      });
      // Never overwrite: only a row with no recording yet takes one.
      if (u.record && !u.fresh) {
        await prisma.branch.updateMany({
          where: { repoId, name: u.name, recordedAt: null },
          data: { recordedParents: u.record, recordedAt: now },
        });
      }
    }
    for (let i = 0; i < plan.remove.length; i += IN_BATCH) {
      await prisma.branch.updateMany({
        where: { repoId, name: { in: plan.remove.slice(i, i + IN_BATCH) }, deletedAt: null },
        data: { deletedAt: now, isDefault: false },
      });
    }
  },

  async staleRepos(repoIds, cutoff, limit) {
    const out: { repoId: string; orgId: string }[] = [];
    for (let i = 0; i < repoIds.length && out.length < limit; i += IN_BATCH) {
      const rows = await prisma.repoGraph.findMany({
        where: {
          repoId: { in: repoIds.slice(i, i + IN_BATCH) },
          OR: [{ syncedAt: null }, { syncedAt: { lt: cutoff } }],
          repo: { active: true },
        },
        select: { repoId: true, repo: { select: { orgId: true } } },
        take: limit - out.length,
      });
      out.push(...rows.map((r) => ({ repoId: r.repoId, orgId: r.repo.orgId })));
    }
    return out;
  },
};

// --- Redis state ---

/** The subset of ioredis the refresh state uses. */
export interface RefreshRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
}

export const refreshCursorKey = (repoId: string) => `tree:refresh-cursor:${repoId}`;
export const TREE_VIEWS_KEY = 'tree:views';
const CURSOR_TTL_S = 30 * 24 * 60 * 60;

export function redisTreeRefreshState(redis: RefreshRedis): TreeRefreshState {
  return {
    async getCursor(repoId) {
      const raw = await redis.get(refreshCursorKey(repoId));
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Partial<RefreshCursor>;
        return typeof v.at === 'string' && typeof v.id === 'string' ? { at: v.at, id: v.id } : null;
      } catch {
        return null;
      }
    },
    async setCursor(repoId, cursor) {
      await redis.set(refreshCursorKey(repoId), JSON.stringify(cursor), 'EX', CURSOR_TTL_S);
    },
    async recordView(repoId, at) {
      await redis.zadd(TREE_VIEWS_KEY, at.getTime(), repoId);
    },
    async viewedSince(since) {
      return redis.zrangebyscore(TREE_VIEWS_KEY, since.getTime(), '+inf');
    },
    async dropViewsBefore(before) {
      await redis.zremrangebyscore(TREE_VIEWS_KEY, '-inf', `(${before.getTime()}`);
    },
  };
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

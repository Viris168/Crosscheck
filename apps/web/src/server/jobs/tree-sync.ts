// tree-sync (`tree/sync-requested`): refresh a repo's branches, PRs, CI and commits-only clone, then write
// the `RepoGraph` snapshot the Branches page draws (tasks/T-branch-tree.md, T2c).
// Privacy: Inngest persists step outputs, so every step returns counts only: never commits, SHAs lists,
// branch names, PR titles or the repo name. Each step re-reads what it needs from the DB.
import { prisma } from '@app/db';
import {
  CommitGraph,
  buildSnapshot,
  pickCompareWith,
  prMerge,
  type BranchInput,
  type CommitInput,
  type Lookup,
  type PrRecord,
} from '@app/git-graph';
import type { TreePr } from '@app/github';
import {
  TREE_MAX_BRANCHES,
  TREE_MAX_COMMITS,
  TreeSnapshotSchema,
  type CiState,
  type ErrorCode,
  type MergedVia,
  type TreeSnapshot,
  type TreeSyncReason,
} from '@app/shared';
import type { JobLogger } from './deps';
import { errorCodeOf, errorMessageOf, nonRetriable, retriable } from './errors';
import { RepoBusyError, type CacheRepo, type GitAuth } from './repo-cache';

type Reason = (typeof TreeSyncReason)[number];

// --- GitHub reads (T2b's `@app/github` tree functions, bound to one installation) ---

export type { TreePr };

export interface TreeRepo extends CacheRepo {
  id: string;
  orgId: string;
  fullName: string;
  githubInstallationId: number;
}

export interface TreeGithub {
  listBranches(
    repo: TreeRepo,
  ): Promise<{ defaultBranch: string; branches: { name: string; headSha: string }[] }>;
  listPullRequests(repo: TreeRepo): Promise<TreePr[]>;
  fetchCiState(
    repo: TreeRepo,
    sha: string,
  ): Promise<{ state: CiState; counts: Record<string, number> }>;
  gitAuth(repo: TreeRepo): Promise<GitAuth>;
}

export interface TreeCache {
  ensureClone(repo: CacheRepo, auth: GitAuth): Promise<{ action: string }>;
  /** Commits reachable from `heads`; heads not in the clone are reported in `missing`. */
  readGraph(
    repo: CacheRepo,
    heads: readonly string[],
  ): Promise<{
    commits: CommitInput[];
    truncated: boolean;
    missing: ReadonlySet<string>;
  }>;
  /** Keep the graph the snapshot was built from for the API (T6a graph cache). */
  saveGraph(
    repo: CacheRepo,
    heads: readonly { name: string; headSha: string }[],
    graph: CommitGraph,
  ): Promise<void>;
}

// --- DB access ---

export interface LiveBranch {
  name: string;
  headSha: string;
  isDefault: boolean;
  recordedParents: string[];
  recordedAt: Date | null;
}

export interface ExistingBranch {
  name: string;
  headSha: string;
  isDefault: boolean;
  deletedAt: Date | null;
}

export interface ExistingPr {
  number: number;
  state: TreePr['state'];
  headSha: string;
  baseRef: string;
  baseSha: string | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
}

export interface TreeStore {
  getRepo(repoId: string): Promise<(TreeRepo & { active: boolean }) | null>;
  setSyncing(repoId: string): Promise<void>;
  setFailed(repoId: string, code: ErrorCode): Promise<void>;
  applyBranches(repoId: string, plan: BranchPlan, now: Date): Promise<void>;
  existingBranches(repoId: string): Promise<ExistingBranch[]>;
  applyPrs(repoId: string, plan: PrPlan): Promise<void>;
  existingPrs(repoId: string, numbers: number[]): Promise<ExistingPr[]>;
  /** Live branches: default first, then most recently moved. */
  liveBranches(repoId: string): Promise<LiveBranch[]>;
  terminalCiShas(repoId: string, shas: string[]): Promise<Set<string>>;
  saveCi(
    repoId: string,
    sha: string,
    ci: { state: CiState; counts: Record<string, number> },
  ): Promise<void>;
  ciStates(repoId: string, shas: string[]): Promise<Map<string, CiState>>;
  prRecords(repoId: string): Promise<PrRecord[]>;
  overrides(repoId: string): Promise<Record<string, string>>;
  saveSnapshot(
    repoId: string,
    data: { defaultBranch: string; snapshot: TreeSnapshot; syncedAt: Date },
  ): Promise<void>;
}

// --- merged state (T3b; rules in tasks/T-branch-tree.md → "Merged-state rules") ---

/** One branch the detector checks: its head and its compare-with target. */
export interface MergedDetectBranch {
  name: string;
  headSha: string;
  compareWith: string;
  targetSha: string;
}

export interface MergedDetectInput {
  defaultBranch: string;
  /** every live branch: the detector picks compare-with targets from all of them */
  branches: readonly BranchInput[];
  graph: readonly CommitInput[];
  prs: readonly PrRecord[];
  overrides: Lookup;
  /** the branches to content-check (no cache answer yet) */
  check: readonly MergedDetectBranch[];
}

/** Per branch name: how it merged, or null = checked and not merged. A branch left out was not checked. */
export type MergedOutcome = MergedVia | null;

/** Cached outcome per `branch@headSha@targetSha`. */
export type MergedCacheValue = MergedVia | 'none';

export interface TreeMerged {
  /** T3a's `detectMergedWithFallbacks` on the repo's clone. Opens the throwaway workspace; may throw. */
  detect(
    repo: TreeRepo,
    auth: GitAuth,
    input: MergedDetectInput,
  ): Promise<ReadonlyMap<string, MergedOutcome>>;
  /** Redis hash `tree:merged:<repoId>` (field `branch@headSha@targetSha`). */
  readCache(repoId: string): Promise<Map<string, string>>;
  /** Replaces the hash with `entries` (drops fields for old heads) and sets its 7-day TTL. */
  writeCache(repoId: string, entries: ReadonlyMap<string, MergedCacheValue>): Promise<void>;
}

/** The cache's TTL: the content rule runs at most once per branch head per week. */
export const MERGED_CACHE_TTL_S = 7 * 24 * 60 * 60;
export const mergedCacheKey = (repoId: string) => `tree:merged:${repoId}`;
export const mergedCacheField = (name: string, headSha: string, targetSha: string) =>
  `${name}@${headSha}@${targetSha}`;

export interface TreeSyncDeps {
  store: TreeStore;
  github: TreeGithub;
  cache: TreeCache;
  merged: TreeMerged;
  now(): Date;
  log: JobLogger;
}

export interface TreeSyncStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface TreeSyncEvent {
  repoId: string;
  orgId: string;
  reason: Reason;
}

export type TreeSyncResult =
  | { status: 'ready'; branches: number; commits: number; truncated: boolean }
  | { status: 'skipped'; reason: 'repo_missing' | 'busy' }
  | { status: 'failed'; errorCode: ErrorCode };

/** CI is fetched for at most this many branch heads per run. */
export const CI_MAX_PER_RUN = 200;
const CI_PARALLEL = 4;
/** Terminal CI states are cached forever per SHA; pending / none are fetched again. */
export const TERMINAL_CI: readonly CiState[] = ['success', 'failure', 'neutral'];
/** Per-branch commit caps tried in order until the snapshot fits `TREE_MAX_COMMITS`. */
const COMMIT_CAPS = [50, 20, 10, 5, 2];

export async function treeSyncHandler(
  ctx: { event: { data: TreeSyncEvent }; step: TreeSyncStep },
  deps: TreeSyncDeps,
): Promise<TreeSyncResult> {
  const { repoId, reason } = ctx.event.data;
  const { step } = ctx;
  const { store, github, cache, log } = deps;

  const loadRepo = async (): Promise<TreeRepo> => {
    const repo = await store.getRepo(repoId);
    if (!repo || !repo.active) throw nonRetriable('internal', 'repo missing or inactive');
    return repo;
  };

  try {
    const refs = await step.run('load-refs', async () => {
      const repo = await store.getRepo(repoId);
      if (!repo || !repo.active) return { skipped: true as const };
      await store.setSyncing(repoId);
      const [listed, prs] = await Promise.all([
        githubCall(() => github.listBranches(repo), 'branch list failed'),
        githubCall(() => github.listPullRequests(repo), 'pull request list failed'),
      ]);
      const branchPlan = planBranches(
        await store.existingBranches(repoId),
        listed.branches,
        listed.defaultBranch,
      );
      await store.applyBranches(repoId, branchPlan, deps.now());
      const prPlan = planPrs(
        await store.existingPrs(
          repoId,
          prs.map((p) => p.number),
        ),
        prs,
      );
      await store.applyPrs(repoId, prPlan);
      return {
        skipped: false as const,
        branches: listed.branches.length,
        branchesCreated: branchPlan.create.length,
        branchesUpdated: branchPlan.update.length,
        branchesDeleted: branchPlan.softDelete.length,
        prs: prs.length,
        prsCreated: prPlan.create.length,
        prsUpdated: prPlan.update.length,
      };
    });
    if (refs.skipped) {
      log.warn({ repoId, reason }, 'tree-sync skipped: repo missing or inactive');
      return { status: 'skipped', reason: 'repo_missing' };
    }

    await step.run('fetch', async () => {
      const repo = await loadRepo();
      const auth = await githubCall(() => github.gitAuth(repo), 'git token failed');
      await cache.ensureClone(repo, auth);
      return { ok: true };
    });

    const snap = await rebuildSnapshotSteps(step, deps, repoId);

    log.info({ repoId, reason, ...snap }, 'tree-sync done');
    return {
      status: 'ready',
      branches: snap.branches,
      commits: snap.commits,
      truncated: snap.truncated,
    };
  } catch (err) {
    if (errorMessageOf(err) === errorMessageOf(new RepoBusyError())) {
      // Another sync owns the clone and will write the snapshot; don't mark this repo failed.
      log.warn({ repoId, reason }, 'tree-sync skipped: clone busy');
      return { status: 'skipped', reason: 'busy' };
    }
    const code = errorCodeOf(err);
    await step.run('mark-failed', async () => {
      await store.setFailed(repoId, code);
      return { errorCode: code };
    });
    // errorMessageOf: our own messages; git errors are scrubbed of tokens by runGit.
    log.error({ repoId, reason, errorCode: code, err: errorMessageOf(err) }, 'tree-sync failed');
    return { status: 'failed', errorCode: code };
  }
}

/** Which branch heads the `ci` step looks at (tree-refresh passes the heads its events touched). */
export interface CiStepOptions {
  /** only these SHAs (default: every live head) */
  only?: readonly string[];
  /** re-fetch these even if their cached state is terminal (a CI event said it changed) */
  force?: readonly string[];
  /**
   * Write the snapshot right away (refs + cached CI/merged state), then run CI and the content check
   * and write it again. tree-refresh uses this so a push shows within seconds: the GitHub CI reads
   * and the content workspace can take several more.
   */
  snapshotFirst?: boolean;
}

/**
 * The `ci`, `merged` and `snapshot` steps (T2c + T3b): CI for branch heads, content-merged detection with
 * its Redis cache, then the snapshot from the clone + DB. Shared by tree-sync and tree-refresh (T5b).
 * Throws like the steps do; the caller decides what a failure means.
 */
export async function rebuildSnapshotSteps(
  step: TreeSyncStep,
  deps: TreeSyncDeps,
  repoId: string,
  ciOpts: CiStepOptions = {},
): Promise<{ branches: number; commits: number; skippedBranches: number; truncated: boolean }> {
  const { store, github, cache, merged, log } = deps;
  const loadRepo = async (): Promise<TreeRepo> => {
    const repo = await store.getRepo(repoId);
    if (!repo || !repo.active) throw nonRetriable('internal', 'repo missing or inactive');
    return repo;
  };

  const runCi = () =>
    step.run('ci', async () => {
      let heads = unique((await store.liveBranches(repoId)).map((b) => b.headSha));
      if (ciOpts.only) {
        const only = new Set(ciOpts.only);
        heads = heads.filter((s) => only.has(s));
      }
      const force = new Set(ciOpts.force ?? []);
      const terminal = await store.terminalCiShas(repoId, heads);
      for (const s of force) terminal.delete(s);
      const todo = heads.filter((s) => !terminal.has(s)).slice(0, CI_MAX_PER_RUN);
      const repo = todo.length ? await loadRepo() : null;
      await mapLimit(todo, CI_PARALLEL, async (sha) => {
        const ci = await githubCall(() => github.fetchCiState(repo!, sha), 'CI read failed');
        await store.saveCi(repoId, sha, ci);
      });
      return {
        heads: heads.length,
        cached: terminal.size,
        fetched: todo.length,
        deferred: heads.length - terminal.size - todo.length,
      };
    });

  /** What both `merged` and `snapshot` build on. Re-read per step: step outputs carry counts only. */
  const readInputs = async (repo: TreeRepo) => {
    const all = await store.liveBranches(repoId);
    const def = all.find((b) => b.isDefault);
    if (!def) throw nonRetriable('internal', 'repo has no default branch');
    const capped = all.slice(0, TREE_MAX_BRANCHES);
    const graph = await cache.readGraph(repo, unique(capped.map((b) => b.headSha)));
    // A head the clone lacks moved after `fetch` (force-push in between): leave it for the next sync.
    if (graph.missing.has(def.headSha))
      throw retriable('github_error', 'default branch head not in clone yet');
    const branches = capped.filter((b) => !graph.missing.has(b.headSha));
    const [prs, overrides] = await Promise.all([store.prRecords(repoId), store.overrides(repoId)]);
    return { all, def, capped, graph, branches, prs, overrides };
  };

  const runMerged = () =>
    step.run('merged', async () => {
      const repo = await loadRepo();
      const out = { checked: 0, merged: 0, byVia: { pr: 0, rebased: 0, squashed: 0 } };
      const count = (via: MergedVia) => {
        out.merged++;
        out.byVia[via]++;
      };
      // Nothing in here fails the sync: on any error those branches simply stay unmerged.
      let stage: 'graph' | 'cache' | 'workspace' = 'graph';
      try {
        const { def, graph, branches, prs, overrides } = await readInputs(repo);
        const cg = new CommitGraph(graph.commits);
        const choices = pickCompareWith({
          graph: cg,
          defaultBranch: def.name,
          branches,
          overrides,
          prs,
        });
        const heads = new Map(branches.map((b) => [b.name, b.headSha]));
        stage = 'cache';
        const cached = await merged.readCache(repoId).catch((err: unknown) => {
          log.warn(
            { repoId, reason: 'cache_unavailable', errorCode: errorCodeOf(err) },
            'tree-sync merged: cache read failed',
          );
          return new Map<string, string>();
        });
        const keep = new Map<string, MergedCacheValue>();
        const todo: MergedDetectBranch[] = [];
        const fieldOf = new Map<string, string>();
        for (const b of branches) {
          if (b.name === def.name) continue;
          // Rule 1 (PR record) is cheap and always fresh: `buildSnapshot` applies it again.
          if (prMerge(cg, b, prs)) {
            count('pr');
            continue;
          }
          const target = choices.get(b.name)?.compareWith;
          const targetSha = target ? heads.get(target) : undefined;
          if (!target || !targetSha) continue;
          const field = mergedCacheField(b.name, b.headSha, targetSha);
          const hit = parseCached(cached.get(field));
          if (hit) {
            keep.set(field, hit);
            if (hit !== 'none') count(hit);
            continue;
          }
          fieldOf.set(b.name, field);
          todo.push({ name: b.name, headSha: b.headSha, compareWith: target, targetSha });
        }
        if (todo.length) {
          stage = 'workspace';
          out.checked = todo.length;
          try {
            const auth = await github.gitAuth(repo); // fresh token: the workspace fetches contents
            const found = await merged.detect(repo, auth, {
              defaultBranch: def.name,
              branches,
              graph: graph.commits,
              prs,
              overrides,
              check: todo,
            });
            for (const b of todo) {
              const r = found.get(b.name);
              if (r === undefined) continue; // not checked (cap or timeout): try again next sync
              keep.set(fieldOf.get(b.name)!, r ?? 'none');
              if (r) count(r);
            }
          } catch (err) {
            log.warn(
              { repoId, reason: 'workspace_failed', errorCode: errorCodeOf(err) },
              'tree-sync merged: content check failed',
            );
          }
        }
        stage = 'cache';
        await merged.writeCache(repoId, keep).catch((err: unknown) => {
          log.warn(
            { repoId, reason: 'cache_unavailable', errorCode: errorCodeOf(err) },
            'tree-sync merged: cache write failed',
          );
        });
      } catch (err) {
        log.warn(
          { repoId, reason: `${stage}_failed`, errorCode: errorCodeOf(err) },
          'tree-sync merged: skipped',
        );
      }
      return out;
    });

  const runSnapshot = (id: 'snapshot-early' | 'snapshot') =>
    step.run(id, async () => {
      const repo = await loadRepo();
      const { all, def, capped, graph, branches, prs, overrides } = await readInputs(repo);
      const ci = await store.ciStates(repoId, unique(branches.map((b) => b.headSha)));
      const contentMerged = await merged.readCache(repoId).catch((err: unknown) => {
        log.warn(
          { repoId, reason: 'cache_unavailable', errorCode: errorCodeOf(err) },
          'tree-sync snapshot: merged cache read failed',
        );
        return new Map<string, string>();
      });
      const headOf = new Map(branches.map((b) => [b.name, b.headSha]));
      const truncated = graph.truncated || capped.length < all.length;
      const commitGraph = new CommitGraph(graph.commits);
      let snapshot: TreeSnapshot | undefined;
      for (const cap of COMMIT_CAPS) {
        const built = buildSnapshot({
          defaultBranch: def.name,
          branches: branches.map((b) => ({
            name: b.name,
            headSha: b.headSha,
            recordedParents: b.recordedParents,
            // "recorded" only when the push webhook saw a parent; zero matches → the engine infers.
            recorded: b.recordedAt !== null && b.recordedParents.length > 0,
          })),
          graph: commitGraph,
          prs,
          overrides,
          ci,
          truncated,
          maxCommitsPerBranch: cap,
        });
        applyContentMerged(built.branches, headOf, contentMerged);
        if (built.commits.length <= TREE_MAX_COMMITS || cap === COMMIT_CAPS.at(-1)) {
          if (built.commits.length > TREE_MAX_COMMITS) {
            built.commits = built.commits.slice(-TREE_MAX_COMMITS);
            built.truncated = true;
          }
          const parsed = TreeSnapshotSchema.safeParse(built);
          // No zod details: issues can quote branch names.
          if (!parsed.success) throw nonRetriable('internal', 'snapshot failed validation');
          snapshot = parsed.data;
          break;
        }
      }
      await store.saveSnapshot(repoId, {
        defaultBranch: def.name,
        snapshot: snapshot!,
        syncedAt: deps.now(),
      });
      // After the snapshot: a reader that comes in between sees other heads than the old file was
      // written for, ignores it and reads the clone. Only a cache, so a failed write never fails the sync.
      await cache.saveGraph(repo, branches, commitGraph).catch(() => {
        log.warn({ repoId, reason: 'graph_cache_failed' }, 'tree-sync: graph cache write failed');
      });
      return {
        branches: snapshot!.branches.length,
        commits: snapshot!.commits.length,
        skippedBranches: capped.length - branches.length,
        truncated: snapshot!.truncated,
      };
    });

  if (ciOpts.snapshotFirst) await runSnapshot('snapshot-early');
  await runCi();
  await runMerged();
  return runSnapshot('snapshot');
}

// --- merged state (pure) ---

function parseCached(v: string | undefined): MergedCacheValue | null {
  return v === 'pr' || v === 'rebased' || v === 'squashed' || v === 'none' ? v : null;
}

/**
 * Rule 2 (content) results from the cache onto branches rule 1 left unmerged.
 * VERIFY(T3a): once `buildSnapshot` takes the content results itself, pass them in and drop this.
 */
export function applyContentMerged(
  branches: ReturnType<typeof buildSnapshot>['branches'],
  headOf: ReadonlyMap<string, string>,
  cached: ReadonlyMap<string, string>,
): void {
  for (const b of branches) {
    if (b.merged || b.isDefault || !b.compareWith) continue;
    const targetSha = headOf.get(b.compareWith);
    if (!targetSha) continue;
    const via = cached.get(mergedCacheField(b.name, b.headSha, targetSha));
    if (via === 'rebased' || via === 'squashed')
      b.merged = {
        via,
        prNumber: null,
        method: null,
        into: b.compareWith,
        newCommits: 0,
        mergeCommitSha: null,
      };
  }
}

// --- planning (pure) ---

export interface BranchPlan {
  create: { name: string; headSha: string; isDefault: boolean }[];
  /** existing rows that moved, changed default-ness, or came back after a delete */
  update: { name: string; headSha: string; isDefault: boolean; restored: boolean }[];
  /** names to soft-delete (`deletedAt = now`) */
  softDelete: string[];
}

export function planBranches(
  existing: readonly ExistingBranch[],
  incoming: readonly { name: string; headSha: string }[],
  defaultBranch: string,
): BranchPlan {
  const byName = new Map(existing.map((b) => [b.name, b]));
  const seen = new Set<string>();
  const plan: BranchPlan = { create: [], update: [], softDelete: [] };
  for (const b of incoming) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    const isDefault = b.name === defaultBranch;
    const row = byName.get(b.name);
    if (!row) plan.create.push({ name: b.name, headSha: b.headSha, isDefault });
    else if (row.deletedAt || row.headSha !== b.headSha || row.isDefault !== isDefault)
      plan.update.push({ name: b.name, headSha: b.headSha, isDefault, restored: !!row.deletedAt });
  }
  for (const row of existing)
    if (!row.deletedAt && !seen.has(row.name)) plan.softDelete.push(row.name);
  return plan;
}

export interface PrPlan {
  create: TreePr[];
  update: TreePr[];
}

/** Only the tree fields are compared/updated; title, body, reviews etc. belong to other lanes. */
export function planPrs(existing: readonly ExistingPr[], incoming: readonly TreePr[]): PrPlan {
  const byNumber = new Map(existing.map((p) => [p.number, p]));
  const plan: PrPlan = { create: [], update: [] };
  const seen = new Set<number>();
  for (const pr of incoming) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    const row = byNumber.get(pr.number);
    if (!row) plan.create.push(pr);
    else if (
      row.state !== pr.state ||
      row.headSha !== pr.headSha ||
      row.baseRef !== pr.baseRef ||
      (row.baseSha ?? null) !== (pr.baseSha ?? null) ||
      (row.mergeCommitSha ?? null) !== (pr.mergeCommitSha ?? null) ||
      (row.mergedAt?.getTime() ?? null) !== (toDate(pr.mergedAt)?.getTime() ?? null)
    )
      plan.update.push(pr);
  }
  return plan;
}

// --- Prisma store ---

const BATCH = 100;

export const prismaTreeStore: TreeStore = {
  async getRepo(repoId) {
    const r = await prisma.repo.findUnique({
      where: { id: repoId },
      select: {
        id: true,
        orgId: true,
        githubRepoId: true,
        fullName: true,
        active: true,
        installation: { select: { githubInstallationId: true } },
      },
    });
    if (!r) return null;
    return {
      id: r.id,
      orgId: r.orgId,
      githubRepoId: r.githubRepoId,
      fullName: r.fullName,
      active: r.active,
      githubInstallationId: r.installation.githubInstallationId,
    };
  },

  async setSyncing(repoId) {
    await prisma.repoGraph.upsert({
      where: { repoId },
      create: { repoId, status: 'syncing' },
      update: { status: 'syncing', errorCode: null },
    });
  },

  async setFailed(repoId, code) {
    // Keep the last good snapshot: the page shows it with the error.
    await prisma.repoGraph.upsert({
      where: { repoId },
      create: { repoId, status: 'failed', errorCode: code },
      update: { status: 'failed', errorCode: code },
    });
  },

  existingBranches(repoId) {
    return prisma.branch.findMany({
      where: { repoId },
      select: { name: true, headSha: true, isDefault: true, deletedAt: true },
    });
  },

  async applyBranches(repoId, plan, now) {
    for (const part of chunks(plan.create, BATCH)) {
      await prisma.branch.createMany({
        data: part.map((b) => ({ repoId, ...b })),
        skipDuplicates: true,
      });
    }
    for (const part of chunks(plan.update, BATCH)) {
      await prisma.$transaction(
        part.map((b) =>
          prisma.branch.update({
            where: { repoId_name: { repoId, name: b.name } },
            data: {
              headSha: b.headSha,
              isDefault: b.isDefault,
              deletedAt: null,
              // A branch that comes back under an old name is a new branch: forget what was recorded.
              ...(b.restored ? { recordedParents: [], recordedAt: null } : {}),
            },
          }),
        ),
      );
    }
    for (const part of chunks(plan.softDelete, BATCH)) {
      await prisma.branch.updateMany({
        where: { repoId, name: { in: part }, deletedAt: null },
        data: { deletedAt: now, isDefault: false },
      });
    }
  },

  async existingPrs(repoId, numbers) {
    const out: ExistingPr[] = [];
    for (const part of chunks(numbers, 1000)) {
      out.push(
        ...(await prisma.pullRequest.findMany({
          where: { repoId, number: { in: part } },
          select: {
            number: true,
            state: true,
            headSha: true,
            baseRef: true,
            baseSha: true,
            mergedAt: true,
            mergeCommitSha: true,
          },
        })),
      );
    }
    return out;
  },

  async applyPrs(repoId, plan) {
    const tree = (p: TreePr) => ({
      state: p.state,
      headSha: p.headSha,
      baseRef: p.baseRef,
      baseSha: p.baseSha,
      mergedAt: toDate(p.mergedAt),
      mergeCommitSha: p.mergeCommitSha,
    });
    for (const part of chunks(plan.create, BATCH)) {
      // Reviews are never touched; a PR row created here gets its title/author from the list call.
      await prisma.pullRequest.createMany({
        data: part.map((p) => ({
          repoId,
          number: p.number,
          title: p.title,
          author: p.author,
          headRef: p.headRef,
          ...tree(p),
        })),
        skipDuplicates: true,
      });
    }
    for (const part of chunks(plan.update, BATCH)) {
      await prisma.$transaction(
        part.map((p) =>
          prisma.pullRequest.update({
            where: { repoId_number: { repoId, number: p.number } },
            data: tree(p),
          }),
        ),
      );
    }
  },

  async liveBranches(repoId) {
    return prisma.branch.findMany({
      where: { repoId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }, { name: 'asc' }],
      select: {
        name: true,
        headSha: true,
        isDefault: true,
        recordedParents: true,
        recordedAt: true,
      },
    });
  },

  async terminalCiShas(repoId, shas) {
    const rows = await prisma.commitCi.findMany({
      where: { repoId, sha: { in: shas }, state: { in: [...TERMINAL_CI] } },
      select: { sha: true },
    });
    return new Set(rows.map((r) => r.sha));
  },

  async saveCi(repoId, sha, ci) {
    await prisma.commitCi.upsert({
      where: { repoId_sha: { repoId, sha } },
      create: { repoId, sha, state: ci.state, counts: ci.counts },
      update: { state: ci.state, counts: ci.counts },
    });
  },

  async ciStates(repoId, shas) {
    const rows = await prisma.commitCi.findMany({
      where: { repoId, sha: { in: shas } },
      select: { sha: true, state: true },
    });
    return new Map(rows.map((r) => [r.sha, r.state]));
  },

  async prRecords(repoId) {
    const rows = await prisma.pullRequest.findMany({
      where: { repoId },
      select: {
        number: true,
        headRef: true,
        baseRef: true,
        state: true,
        headSha: true,
        mergeCommitSha: true,
        author: true,
      },
    });
    // No mergeMethod: GitHub's PR API doesn't give it; `detectMerged` infers it from the graph.
    return rows;
  },

  async overrides(repoId) {
    const rows = await prisma.compareOverride.findMany({
      where: { repoId },
      select: { branchName: true, compareWith: true },
    });
    return Object.fromEntries(rows.map((r) => [r.branchName, r.compareWith]));
  },

  async saveSnapshot(repoId, { defaultBranch, snapshot, syncedAt }) {
    const data = {
      status: 'ready' as const,
      errorCode: null,
      defaultBranch,
      syncedAt,
      snapshot: snapshot as unknown as object,
    };
    await prisma.repoGraph.upsert({ where: { repoId }, create: { repoId, ...data }, update: data });
  },
};

// --- Redis merged cache ---

/** The subset of ioredis the merged cache uses. */
export interface MergedRedis {
  hgetall(key: string): Promise<Record<string, string>>;
  multi(): {
    del(key: string): unknown;
    hset(key: string, values: Record<string, string>): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown>;
  };
}

export function redisTreeMerged(redis: MergedRedis, detect: TreeMerged['detect']): TreeMerged {
  return {
    detect,
    async readCache(repoId) {
      return new Map(Object.entries(await redis.hgetall(mergedCacheKey(repoId))));
    },
    async writeCache(repoId, entries) {
      const key = mergedCacheKey(repoId);
      const tx = redis.multi();
      tx.del(key);
      if (entries.size) {
        tx.hset(key, Object.fromEntries(entries));
        tx.expire(key, MERGED_CACHE_TTL_S);
      }
      await tx.exec();
    },
  };
}

// --- helpers ---

/** GitHub API failures become retriable `github_error`s with a generic message (no repo/branch names). */
export async function githubCall<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'rate_limited' || code === 'timeout') throw retriable(code, message);
    throw retriable('github_error', message);
  }
}

function toDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function mapLimit<T>(xs: readonly T[], limit: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < xs.length) await fn(xs[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
}

import { createHash } from 'node:crypto';
import { prisma } from '@app/db';
import {
  GetTreeQuery,
  GetTreeResponse,
  TreeParams,
  TREE_MAX_COMMITS,
  TreeSnapshotSchema,
  type TreeSnapshot,
} from '@app/shared';
import { isComputed } from '@/components/tree/scale-contract';
import { canEditRepo, requireRepoAccess } from '@/lib/server/access';
import { json, queryOf, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { recordTreeView } from '@/server/jobs';
import { logger } from '@/server/logger';
import { buildSnapshot } from '@app/git-graph';
import { etagMatches, treeEtag } from './etag';
import { loadCommitGraph } from './graph-source';
import { loadOverrides, withOverrides } from './overrides';
import {
  FIRST_VIEW_WINDOW_SECONDS,
  firstViewKey,
  requestInSlot,
  startTreeSync,
  takeSlot,
} from './sync-request';

export const dynamic = 'force-dynamic';

/** Browsers must revalidate (the page polls with If-None-Match); never shared caches. */
const CACHE_CONTROL = 'private, no-cache';

/** Each `visible` set gets its own validator: the body differs by which rows were filled in. */
function etagForVisible(etag: string, visible: readonly string[] | undefined): string {
  if (!visible?.length) return etag;
  const h = createHash('sha256')
    .update(JSON.stringify([...visible].sort()))
    .digest('base64url')
    .slice(0, 12);
  return etag.replace(/"$/, `.${h}"`);
}

/**
 * Fills in ahead/behind/merge-base for `visible` rows (and their compare-with chains) that the stored
 * snapshot left NOT_COMPUTED (T6a lazy table), from the cache clone's graph. Compare-with stays as
 * stored: it is passed back as overrides so the engine only measures. Rows already computed are
 * untouched; with today's full snapshots this returns without reading any graph.
 */
async function fillVisible(
  repo: { id: string; githubRepoId: number },
  snapshot: TreeSnapshot,
  visible: readonly string[],
): Promise<TreeSnapshot> {
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const want = new Set<string>();
  for (const v of visible) {
    for (let b = byName.get(v); b && !want.has(b.name);) {
      want.add(b.name);
      b = b.compareWith ? byName.get(b.compareWith) : undefined;
    }
  }
  const todo = [...want].filter((n) => !isComputed(byName.get(n)!));
  if (!todo.length) return snapshot;

  const graph = await loadCommitGraph(repo, snapshot.branches);
  if (!graph || snapshot.branches.some((b) => !graph.has(b.headSha))) {
    logger.warn({ repoId: repo.id, rows: todo.length }, 'tree visible rows left uncomputed');
    return snapshot;
  }
  const lazy = buildSnapshot({
    defaultBranch: snapshot.defaultBranch,
    branches: snapshot.branches.map((b) => ({ name: b.name, headSha: b.headSha })),
    graph,
    overrides: Object.fromEntries(
      snapshot.branches.flatMap((b) => (b.compareWith ? [[b.name, b.compareWith]] : [])),
    ),
    visible: todo,
  });
  const counted = new Map(lazy.branches.map((b) => [b.name, b]));
  const have = new Set(snapshot.commits.map((c) => c.sha));
  const extra = lazy.commits.filter((c) => !have.has(c.sha));
  return {
    ...snapshot,
    branches: snapshot.branches.map((b) => {
      const c = counted.get(b.name);
      return todo.includes(b.name) && c && isComputed(c)
        ? { ...b, ahead: c.ahead, behind: c.behind, mergeBase: c.mergeBase }
        : b;
    }),
    // Counts are what matter; skip extra commits rather than break the response cap.
    commits:
      snapshot.commits.length + extra.length <= TREE_MAX_COMMITS
        ? [...snapshot.commits, ...extra]
        : snapshot.commits,
  };
}

/** The viewer's GitHub login (the "mine" filter compares it with `pr.author`). Best effort. */
async function viewerLogin(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { login: true } });
  return user?.login ?? null;
}

/**
 * GET /api/repos/:repoId/tree — the stored snapshot; the first view of a repo starts a sync.
 * The page polls it every 3 s with `If-None-Match`; an unchanged tree answers 304 with no body (T5c).
 * `?visible=a&visible=b` (T6b): the rows on screen; their counts are computed if the snapshot lacks them.
 */
/** `GitEvent.kind`s that only arrive when the GitHub App is subscribed to Push (the `liveEvents` flag). */
const PUSH_EVENT_KINDS = ['push', 'branch_created', 'branch_deleted', 'force_push'] as const;

export const GET = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = TreeParams.parse(params);
  const visibleParam = new URL(req.url).searchParams.getAll('visible');
  // `at` is milestone 8; validated, not used yet.
  const { visible } = GetTreeQuery.parse({
    ...queryOf(req),
    visible: visibleParam.length ? visibleParam : undefined,
  });
  // 403 for a non-collaborator, like every repo route since Task H (the page itself answers 404).
  const repo = await requireRepoAccess(session.user.id, repoId);
  // `tree-cron` keeps repos viewed in the last 7 days fresh. Not awaited: never throws, and a slow Redis
  // must not hold up the 3 s poll.
  void recordTreeView(repoId);

  const [graph, canEdit] = await Promise.all([
    prisma.repoGraph.findUnique({ where: { repoId } }),
    canEditRepo(session.user.id, repo),
  ]);

  if (!graph) {
    if (await takeSlot(firstViewKey(repoId), FIRST_VIEW_WINDOW_SECONDS)) {
      const key = firstViewKey(repoId);
      await requestInSlot(key, () => startTreeSync(repoId, repo.orgId, 'first_view'));
    }
    return json(
      GetTreeResponse,
      {
        status: 'syncing',
        syncedAt: null,
        errorCode: null,
        snapshot: null,
        canEdit,
      },
      { headers: { 'cache-control': CACHE_CONTROL } },
    );
  }

  const [overrides, gitEvent] = await Promise.all([
    loadOverrides(repoId),
    // Push kinds only: GitHub sends check_suite (and the review path pull_request) without a Push
    // subscription, so those events don't mean pushes arrive.
    prisma.gitEvent.findFirst({
      where: { repoId, kind: { in: [...PUSH_EVENT_KINDS] } },
      select: { id: true },
    }),
  ]);
  const liveEvents = gitEvent !== null;
  const etag = etagForVisible(
    treeEtag({
      syncedAt: graph.syncedAt,
      updatedAt: graph.updatedAt,
      canEdit,
      overrides,
      liveEvents,
    }),
    visible,
  );
  const headers = { etag, 'cache-control': CACHE_CONTROL };
  if (etagMatches(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  // The snapshot is JSON written by the sync job; a shape we can't read is shown as a failed sync.
  const parsed = graph.snapshot == null ? null : TreeSnapshotSchema.safeParse(graph.snapshot);
  if (parsed && !parsed.success) {
    logger.error({ repoId, issues: parsed.error.issues.length }, 'stored tree snapshot is invalid');
  }
  const unreadable = parsed !== null && !parsed.success;
  // Overrides show right away: re-pick compare-with on the stored graph instead of waiting for a sync.
  const stored = parsed?.success ? await withOverrides(repoId, parsed.data, overrides) : null;
  const snapshot = stored && visible?.length ? await fillVisible(repo, stored, visible) : stored;
  const login = await viewerLogin(session.user.id).catch(() => null);

  return json(
    GetTreeResponse,
    {
      status: unreadable && graph.status !== 'syncing' ? 'failed' : graph.status,
      syncedAt: graph.syncedAt?.toISOString() ?? null,
      errorCode: unreadable ? (graph.errorCode ?? 'internal') : graph.errorCode,
      snapshot,
      canEdit,
      viewerLogin: login,
      liveEvents,
    },
    { headers },
  );
});

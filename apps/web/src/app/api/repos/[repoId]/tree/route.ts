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
import { isComputed, MINE_PRS_HEADER } from '@/components/tree/scale-contract';
import { canEditRepo, requireRepoAccess } from '@/lib/server/access';
import { json, queryOf, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';
import { buildSnapshot } from '@app/git-graph';
import { etagMatches, LIVE_EVENTS_HEADER, treeEtag } from './etag';
import { loadCommitGraph } from './graph-source';
import { loadOverrides, withOverrides } from './overrides';
import {
  FIRST_VIEW_WINDOW_SECONDS,
  firstViewKey,
  requestInSlot,
  requestTreeSync,
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

  const heads = snapshot.branches.map((b) => b.headSha);
  const graph = await loadCommitGraph(repo, heads);
  if (!graph || heads.some((h) => !graph.has(h))) {
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

/** PR numbers in the snapshot that the viewer opened (the "mine" filter). Best effort. */
async function minePrs(userId: string, repoId: string, snapshot: TreeSnapshot): Promise<number[]> {
  const numbers = [...new Set(snapshot.branches.flatMap((b) => (b.pr ? [b.pr.number] : [])))];
  if (!numbers.length) return [];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { login: true } });
  if (!user?.login) return [];
  const rows = await prisma.pullRequest.findMany({
    where: { repoId, author: user.login, number: { in: numbers } },
    select: { number: true },
  });
  return rows.map((r) => r.number).sort((a, b) => a - b);
}

/**
 * GET /api/repos/:repoId/tree — the stored snapshot; the first view of a repo starts a sync.
 * The page polls it every 3 s with `If-None-Match`; an unchanged tree answers 304 with no body (T5c).
 * `?visible=a&visible=b` (T6b): the rows on screen; their counts are computed if the snapshot lacks them.
 */
export const GET = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = TreeParams.parse(params);
  const visibleParam = new URL(req.url).searchParams.getAll('visible');
  // `at` is milestone 8; validated, not used yet.
  const { visible } = GetTreeQuery.parse({
    ...queryOf(req),
    visible: visibleParam.length ? visibleParam : undefined,
  });
  // VERIFY: T2d asks for 404 for a non-collaborator; requireRepoAccess (Task H) answers 403, like every
  // other repo route. Kept consistent with H; unknown repos are 404.
  const repo = await requireRepoAccess(session.user.id, repoId);

  const [graph, canEdit] = await Promise.all([
    prisma.repoGraph.findUnique({ where: { repoId } }),
    canEditRepo(session.user.id, repo),
  ]);

  if (!graph) {
    if (await takeSlot(firstViewKey(repoId), FIRST_VIEW_WINDOW_SECONDS)) {
      const key = firstViewKey(repoId);
      await requestInSlot(key, () => requestTreeSync(repoId, repo.orgId, 'first_view'));
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
    prisma.gitEvent.findFirst({ where: { repoId }, select: { id: true } }),
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
  const headers = {
    etag,
    'cache-control': CACHE_CONTROL,
    [LIVE_EVENTS_HEADER]: liveEvents ? '1' : '0',
  };
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
  const mine = snapshot
    ? await minePrs(session.user.id, repoId, snapshot).catch(() => [] as number[])
    : [];

  return json(
    GetTreeResponse,
    {
      status: unreadable && graph.status !== 'syncing' ? 'failed' : graph.status,
      syncedAt: graph.syncedAt?.toISOString() ?? null,
      errorCode: unreadable ? (graph.errorCode ?? 'internal') : graph.errorCode,
      snapshot,
      canEdit,
    },
    { headers: { ...headers, [MINE_PRS_HEADER]: mine.join(',') } },
  );
});

import { prisma } from '@app/db';
import { GetTreeQuery, GetTreeResponse, TreeParams, TreeSnapshotSchema } from '@app/shared';
import { canEditRepo, requireRepoAccess } from '@/lib/server/access';
import { json, queryOf, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';
import { etagMatches, LIVE_EVENTS_HEADER, treeEtag } from './etag';
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

/**
 * GET /api/repos/:repoId/tree — the stored snapshot; the first view of a repo starts a sync.
 * The page polls it every 3 s with `If-None-Match`; an unchanged tree answers 304 with no body (T5c).
 */
export const GET = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = TreeParams.parse(params);
  GetTreeQuery.parse(queryOf(req)); // `at` is milestone 8; validated, not used yet.
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
  const etag = treeEtag({
    syncedAt: graph.syncedAt,
    updatedAt: graph.updatedAt,
    canEdit,
    overrides,
    liveEvents,
  });
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
  const snapshot = parsed?.success ? await withOverrides(repoId, parsed.data, overrides) : null;

  return json(
    GetTreeResponse,
    {
      status: unreadable && graph.status !== 'syncing' ? 'failed' : graph.status,
      syncedAt: graph.syncedAt?.toISOString() ?? null,
      errorCode: unreadable ? (graph.errorCode ?? 'internal') : graph.errorCode,
      snapshot,
      canEdit,
    },
    { headers },
  );
});

import { prisma } from '@app/db';
import { CompareQuery, CompareResponse, HttpError, TreeParams } from '@app/shared';
import { requireRepoAccess } from '@/lib/server/access';
import { json, queryOf, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';
import { compare } from '@app/git-graph';
import { loadCommitGraph } from '../graph-source';

export const dynamic = 'force-dynamic';

/** Answers for a pair of head SHAs never change; 60 s keeps Redis small (T6b "Do" 4). */
export const COMPARE_CACHE_SECONDS = 60;

/** Keyed by both head SHAs (not names): a push to either branch is a new key. Order matters. */
export const compareCacheKey = (repoId: string, headA: string, headB: string) =>
  `tree:compare:${repoId}:${headA}:${headB}`;

async function cached(key: string) {
  try {
    const raw = await getRedis().get(key);
    if (!raw) return null;
    const parsed = CompareResponse.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Redis down or a bad value: compute instead
  }
}

/**
 * GET /api/repos/:repoId/tree/compare?a=<branch>&b=<branch> — any two branches: how far `a` is ahead of
 * and behind `b`, and their merge base. View access. Computed on the cache clone's commit graph.
 */
export const GET = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = TreeParams.parse(params);
  const { a, b } = CompareQuery.parse(queryOf(req));
  const repo = await requireRepoAccess(session.user.id, repoId);
  if (a === b) throw new HttpError('bad_request', 'Pick two different branches.');

  const rows = await prisma.branch.findMany({
    where: { repoId, deletedAt: null, name: { in: [a, b] } },
    select: { name: true, headSha: true },
  });
  const headA = rows.find((r) => r.name === a)?.headSha;
  const headB = rows.find((r) => r.name === b)?.headSha;
  if (!headA || !headB) throw new HttpError('not_found', 'Unknown branch.');

  const key = compareCacheKey(repoId, headA, headB);
  const hit = await cached(key);
  if (hit) return json(CompareResponse, hit, { headers: { 'cache-control': 'private, no-cache' } });

  const graph = await loadCommitGraph(repo, [headA, headB]);
  if (!graph || !graph.has(headA) || !graph.has(headB))
    throw new HttpError(
      'conflict',
      'The branch tree has not seen the latest commits yet. Refresh it first.',
    );
  const result = compare(graph, headA, headB);
  await getRedis()
    .set(key, JSON.stringify(result), 'EX', COMPARE_CACHE_SECONDS)
    .catch((err: unknown) =>
      logger.warn(
        { repoId, err: err instanceof Error ? err.message : String(err) },
        'tree compare cache write failed',
      ),
    );
  return json(CompareResponse, result, { headers: { 'cache-control': 'private, no-cache' } });
});

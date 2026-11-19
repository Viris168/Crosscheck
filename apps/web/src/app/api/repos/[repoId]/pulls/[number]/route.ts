import { prisma } from '@app/db';
import { GetPullResponse, PullParams } from '@app/shared';
import { requirePullAccess } from '@/lib/server/access';
import { json, route } from '@/lib/server/http';
import { toPullHeader, toReviewDetail, toReviewSummary } from '@/lib/server/serialize';
import { fetchPullFiles } from '@/lib/server/pull-files';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

/** GET /api/repos/:repoId/pulls/:number — header + latest review + changed files (+ history). */
export const GET = route<{ repoId: string; number: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId, number } = PullParams.parse(params);
  const { repo, pull } = await requirePullAccess(session.user.id, repoId, number);

  const [reviews, latest] = await Promise.all([
    prisma.review.findMany({ where: { pullRequestId: pull.id }, orderBy: { createdAt: 'desc' } }),
    prisma.review.findFirst({
      where: { pullRequestId: pull.id },
      orderBy: { createdAt: 'desc' },
      include: { issues: { orderBy: [{ file: 'asc' }, { line: 'asc' }] } },
    }),
  ]);

  // Patches come live from GitHub and are never stored; a GitHub failure must not hide the review.
  const files = await prisma.installation
    .findUnique({ where: { id: repo.installationId } })
    .then((installation) => (installation ? fetchPullFiles(repo, installation, pull) : []))
    .catch((err: unknown) => {
      logger.warn({ repoId, err: (err as Error).message }, 'could not load PR files');
      return [];
    });

  return json(GetPullResponse, {
    pull: toPullHeader(pull, repo),
    review: latest ? toReviewDetail(latest, pull.headSha) : null,
    files,
    reviews: reviews.map((r) => toReviewSummary(r, pull.headSha)),
  });
});

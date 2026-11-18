import { prisma, type Prisma } from '@app/db';
import { ListPullsQuery, ListPullsResponse, RepoParams } from '@app/shared';
import { requireRepoAccess } from '@/lib/server/access';
import { json, queryOf, route } from '@/lib/server/http';
import { toLatestReviewSummary } from '@/lib/server/serialize';
import { requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

const STATE_FILTER: Record<'open' | 'closed' | 'all', Prisma.PullRequestWhereInput> = {
  open: { state: 'open' },
  closed: { state: { in: ['closed', 'merged'] } },
  all: {},
};

/** GET /api/repos/:repoId/pulls?state=open|closed|all */
export const GET = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = RepoParams.parse(params);
  const { state } = ListPullsQuery.parse(queryOf(req));
  await requireRepoAccess(session.user.id, repoId);

  const pulls = await prisma.pullRequest.findMany({
    where: { repoId, ...STATE_FILTER[state] },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  return json(
    ListPullsResponse,
    pulls.map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      author: p.author,
      state: p.state,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      latestReview: toLatestReviewSummary(p.reviews[0], p.headSha),
    })),
  );
});

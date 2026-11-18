import { PullParams, RerunRequest, RerunResponse } from '@app/shared';
import { requirePullAccess } from '@/lib/server/access';
import { json, readJson, route } from '@/lib/server/http';
import { rerunReview } from '@/lib/server/review-actions';
import { requireSession } from '@/server/auth';

/** POST /api/repos/:repoId/pulls/:number/rerun { provider? } — defaults to the repo's provider. */
export const POST = route<{ repoId: string; number: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId, number } = PullParams.parse(params);
  const body = RerunRequest.parse(await readJson(req));
  const { repo, pull } = await requirePullAccess(session.user.id, repoId, number);

  const result = await rerunReview({
    pullRequestId: pull.id,
    headSha: pull.headSha,
    orgId: repo.orgId,
    provider: body.provider ?? repo.provider,
  });
  return json(RerunResponse, result, { status: 202 });
});

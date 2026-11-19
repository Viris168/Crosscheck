import { MergeRequest, MergeResponse, PullParams } from '@app/shared';
import { requirePullWrite } from '@/lib/server/access';
import { json, readJson, route } from '@/lib/server/http';
import { mergeReviewedPull } from '@/lib/server/merge-pull';
import { requireSession } from '@/server/auth';

/**
 * POST /api/repos/:repoId/pulls/:number/merge { method? } — org owner/admin or GitHub `write`+ on
 * the repo: the merge runs with the App's token, so it must not let someone do what their GitHub
 * access doesn't allow.
 */
export const POST = route<{ repoId: string; number: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId, number } = PullParams.parse(params);
  const body = MergeRequest.parse(await readJson(req));
  const { repo, pull } = await requirePullWrite(session.user.id, repoId, number);
  const result = await mergeReviewedPull({
    repo,
    pull,
    method: body.method,
    userId: session.user.id,
  });
  return json(MergeResponse, result);
});

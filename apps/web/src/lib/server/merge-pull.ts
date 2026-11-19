import 'server-only';
import { prisma, type PullRequest, type Repo } from '@app/db';
import { getInstallationOctokit, MergeError, mergePullRequest, splitFullName } from '@app/github';
import { HttpError, type MergeMethod } from '@app/shared';
import { logger } from '@/server/logger';

const REFUSED: Record<MergeError['reason'], (msg: string) => HttpError> = {
  not_mergeable: (msg) => new HttpError('conflict', `GitHub can't merge this pull request: ${msg}`),
  head_changed: () =>
    new HttpError('conflict', 'The branch changed after the review. Review the new commit first.'),
  forbidden: (msg) =>
    new HttpError(
      'forbidden',
      `GitHub refused the merge: ${msg.replace(/\.$/, '')}. The GitHub App needs Contents: Read & write on this repository.`,
    ),
  not_found: () => new HttpError('not_found', 'Pull request not found on GitHub'),
};

/**
 * POST /api/repos/:repoId/pulls/:number/merge — merges on GitHub with the App's installation token,
 * pinned to the head the latest review covered. The caller has already checked owner/admin.
 */
export async function mergeReviewedPull(args: {
  repo: Pick<Repo, 'id' | 'fullName' | 'installationId'>;
  pull: Pick<PullRequest, 'id' | 'number' | 'state' | 'headSha'>;
  method: MergeMethod;
  userId: string;
}): Promise<{ merged: true; sha: string }> {
  const { repo, pull, method, userId } = args;
  if (pull.state !== 'open') throw new HttpError('conflict', 'This pull request is not open');

  const latest = await prisma.review.findFirst({
    where: { pullRequestId: pull.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, headSha: true },
  });
  if (!latest || latest.headSha !== pull.headSha || latest.status !== 'completed') {
    throw new HttpError('conflict', 'Merge needs a completed review of the latest commit');
  }

  const installation = await prisma.installation.findUnique({
    where: { id: repo.installationId },
  });
  if (!installation) throw new HttpError('conflict', 'The GitHub App is not installed');

  const { owner, repo: name } = splitFullName(repo.fullName);
  const log = { repoId: repo.id, reviewId: latest.id, prNumber: pull.number, userId, method };
  let sha: string;
  try {
    const octokit = await getInstallationOctokit(installation.githubInstallationId);
    ({ sha } = await mergePullRequest(octokit, owner, name, pull.number, {
      sha: pull.headSha,
      method,
    }));
  } catch (err) {
    if (err instanceof MergeError) {
      logger.info({ ...log, reason: err.reason }, 'merge refused by GitHub');
      throw REFUSED[err.reason](err.message);
    }
    logger.error({ ...log, err: (err as Error).message }, 'merge failed');
    throw new HttpError('internal', 'Could not reach GitHub to merge. Try again.');
  }

  // The pull_request.closed webhook says the same; this makes the page right immediately.
  await prisma.pullRequest.update({ where: { id: pull.id }, data: { state: 'merged' } });
  logger.info(log, 'pull request merged');
  return { merged: true, sha };
}

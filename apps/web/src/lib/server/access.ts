import 'server-only';
import { prisma } from '@app/db';
import { HttpError, type MemberRole } from '@app/shared';
import { requireOrgMember } from '@/server/auth';

/** Roles allowed to change repo configuration (settings, tokens, workflow PRs). */
export const ADMIN_ROLES: readonly MemberRole[] = ['owner', 'admin'];

/** 404 if the repo does not exist, 403 unless the user is a member of its org. */
export async function requireRepoAccess(
  userId: string,
  repoId: string,
  roles?: readonly MemberRole[],
) {
  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (!repo) throw new HttpError('not_found', 'Repository not found');
  await requireOrgMember(userId, repo.orgId, roles);
  return repo;
}

export async function requirePullAccess(userId: string, repoId: string, number: number) {
  const repo = await requireRepoAccess(userId, repoId);
  const pull = await prisma.pullRequest.findUnique({
    where: { repoId_number: { repoId, number } },
  });
  if (!pull) throw new HttpError('not_found', 'Pull request not found');
  return { repo, pull };
}

export async function requireReviewAccess(userId: string, reviewId: string) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: { pullRequest: { include: { repo: true } } },
  });
  if (!review) throw new HttpError('not_found', 'Review not found');
  await requireOrgMember(userId, review.pullRequest.repo.orgId);
  return review;
}

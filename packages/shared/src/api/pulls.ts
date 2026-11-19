import { z } from 'zod';
import { ProviderId, PullRequestState, ReviewStatus } from '../enums';
import { RiskLevel } from '../risk';
import { Id, IsoDate } from './common';
import { ReviewDetailSchema, ReviewSummarySchema } from './reviews';

export const PullParams = z.object({
  repoId: Id,
  number: z.coerce.number().int().positive(),
});

/** GET /api/repos/:repoId/pulls?state=open|closed|all */
export const ListPullsQuery = z.object({
  state: z.enum(['open', 'closed', 'all']).default('open'),
});

export const LatestReviewSummarySchema = z.object({
  status: z.enum(ReviewStatus),
  riskScore: z.number().nullish(),
  riskLevel: z.enum(RiskLevel).nullish(),
  stale: z.boolean(),
});

export const PullListItemSchema = z.object({
  id: Id,
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  state: z.enum(PullRequestState),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  latestReview: LatestReviewSummarySchema.nullish(),
});
export type PullListItem = z.infer<typeof PullListItemSchema>;

export const ListPullsResponse = z.array(PullListItemSchema);

export const PullHeaderSchema = z.object({
  id: Id,
  repoId: Id,
  repoFullName: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  author: z.string(),
  state: z.enum(PullRequestState),
  headSha: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  updatedAt: IsoDate,
  htmlUrl: z.url(),
});

/** Fetched live from GitHub (patches are never stored). */
export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previousPath: z.string().nullish(),
  /** Unified diff for the viewer; may be missing for binary/huge files. */
  patch: z.string().nullish(),
});

/** GET /api/repos/:repoId/pulls/:number — PR header + latest ReviewDetail + review history + changed files. */
export const GetPullResponse = z.object({
  pull: PullHeaderSchema,
  review: ReviewDetailSchema.nullable(),
  /** Every review of this PR, newest first. Open one with GET /api/reviews/:id. */
  reviews: z.array(ReviewSummarySchema),
  files: z.array(ChangedFileSchema),
});

/** POST /api/repos/:repoId/pulls/:number/rerun */
export const RerunRequest = z.object({
  provider: z.enum(ProviderId).optional(),
});
export const RerunResponse = z.object({
  reviewId: Id,
  status: z.enum(ReviewStatus),
});

export const MergeMethod = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MergeMethod)[number];

/**
 * POST /api/repos/:repoId/pulls/:number/merge — org owner/admin only. Merges the PR on GitHub at the
 * head that was reviewed; 409 if the latest review of the current head is not completed.
 */
export const MergeRequest = z.object({
  method: z.enum(MergeMethod).default('merge'),
});
export const MergeResponse = z.object({
  merged: z.literal(true),
  sha: z.string(),
});

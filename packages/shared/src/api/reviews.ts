import { z } from 'zod';
import { ErrorCode, ProviderId, ReviewStatus } from '../enums';
import { IssueSchema } from '../review-result';
import { RiskResultSchema } from '../risk';
import { Id, IsoDate } from './common';

export const ReviewParams = z.object({ id: Id });

export const ReviewIssueWithIdSchema = IssueSchema.extend({ id: Id, posted: z.boolean() });
export type ReviewIssueWithId = z.infer<typeof ReviewIssueWithIdSchema>;

export const ReviewDetailSchema = z.object({
  id: Id,
  status: z.enum(ReviewStatus),
  provider: z.enum(ProviderId),
  headSha: z.string(),
  /** Derived: review.headSha !== pullRequest.headSha. */
  stale: z.boolean(),
  errorCode: z.enum(ErrorCode).nullish(),
  errorMessage: z.string().nullish(),
  filesTotal: z.number().int().nonnegative(),
  filesDone: z.number().int().nonnegative(),
  risk: RiskResultSchema.nullish(),
  summary: z.string().nullish(),
  issues: z.array(ReviewIssueWithIdSchema),
  createdAt: IsoDate,
  finishedAt: IsoDate.nullish(),
});
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;

/** One row of a PR's review history (GetPullResponse.reviews). */
export const ReviewSummarySchema = z.object({
  id: Id,
  status: z.enum(ReviewStatus),
  provider: z.enum(ProviderId),
  headSha: z.string(),
  stale: z.boolean(),
  createdAt: IsoDate,
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

/** POST /api/reviews/:id/cancel — only `queued` / `waiting_action` reviews; 409 otherwise. */
export const CancelReviewResponse = z.object({
  reviewId: Id,
  status: z.enum(ReviewStatus),
});

/** POST /api/reviews/:id/retry */
export const RetryReviewResponse = z.object({
  reviewId: Id,
  status: z.enum(ReviewStatus),
});

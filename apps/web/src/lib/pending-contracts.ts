// Local, additive extensions of `@app/shared` contracts, waiting on tasks/CONTRACT_REQUESTS.md.
// Each one only ADDS fields/endpoints to an existing shared schema. When the request is applied on
// main, delete the local schema and import the shared one instead.
import {
  GetPullResponse,
  IsoDate,
  LatestReviewSummarySchema,
  ProviderId,
  RepoSchema,
  ReviewStatus,
} from '@app/shared/client';
import { z } from 'zod';

/** [Lane F] Review history on the PR page — GetPullResponse + `reviews`. */
export const ReviewSummarySchema = z.object({
  id: z.string().min(1),
  status: z.enum(ReviewStatus),
  provider: z.enum(ProviderId),
  headSha: z.string(),
  stale: z.boolean(),
  createdAt: IsoDate,
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

export const GetPullWithHistoryResponse = GetPullResponse.extend({
  /** Every review of this PR, newest first. */
  reviews: z.array(ReviewSummarySchema),
});
export type PullDetailData = z.infer<typeof GetPullWithHistoryResponse>;

/** [Lane F] Repo list "last review status" — RepoSchema + `lastReview`. */
export const RepoWithLastReviewSchema = RepoSchema.extend({
  lastReview: LatestReviewSummarySchema.nullish(),
});
export const ListReposWithLastReviewResponse = z.array(RepoWithLastReviewSchema);
export type RepoListItem = z.infer<typeof RepoWithLastReviewSchema>;

/** [Foundation gap] GET /api/connections/chatgpt — connection status for the current user + org. */
export const GetChatGptConnectionResponse = z.object({
  connected: z.boolean(),
  orgId: z.string().nullable(),
  connectedAt: IsoDate.nullish(),
  expiresAt: IsoDate.nullish(),
});
export type ChatGptConnection = z.infer<typeof GetChatGptConnectionResponse>;

import { z } from 'zod';
import { ACTION_PROVIDERS, ProviderId } from '../enums';
import { RepoSettingsSchema } from '../repo-settings';
import { Id } from './common';
import { LatestReviewSummarySchema } from './pulls';

export const RepoParams = z.object({ repoId: Id });

export const RepoSchema = z.object({
  id: Id,
  orgId: Id,
  fullName: z.string(),
  provider: z.enum(ProviderId),
  active: z.boolean(),
  /** true once an ingest token was generated (the token itself is never returned again). */
  hasIngestToken: z.boolean(),
});
export type Repo = z.infer<typeof RepoSchema>;

/** GET /api/repos item: the repo + the latest review of its most recently updated PR. */
export const RepoListItemSchema = RepoSchema.extend({
  lastReview: LatestReviewSummarySchema.nullish(),
});
export type RepoListItem = z.infer<typeof RepoListItemSchema>;

/** GET /api/repos */
export const ListReposResponse = z.array(RepoListItemSchema);

/** GET /api/repos/:repoId/settings */
export const GetRepoSettingsResponse = z.object({
  repoId: Id,
  provider: z.enum(ProviderId),
  settings: RepoSettingsSchema,
  hasIngestToken: z.boolean(),
  /**
   * true when the caller may change settings (org owner/admin, or GitHub `write`+ on the repo).
   * Defaults to false (fail closed) for handlers that don't set it yet.
   */
  canEdit: z.boolean().default(false),
});

/** PUT /api/repos/:repoId/settings — full replacement. */
export const PutRepoSettingsRequest = z.object({
  provider: z.enum(ProviderId),
  settings: RepoSettingsSchema,
});
export const PutRepoSettingsResponse = GetRepoSettingsResponse;

/** POST /api/repos/:repoId/ingest-token/rotate — the token is shown once. */
export const RotateIngestTokenResponse = z.object({
  token: z.string().startsWith('rit_'),
});

/** POST /api/repos/:repoId/setup/workflow-pr */
export const WorkflowPrRequest = z.object({
  provider: z.enum(ACTION_PROVIDERS),
  model: z.string().optional(),
});
export const WorkflowPrResponse = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.url(),
});

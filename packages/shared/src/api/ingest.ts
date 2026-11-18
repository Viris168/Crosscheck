import { z } from 'zod';
import { ReviewResultSchema } from '../review-result';
import { Id } from './common';

/** Sent by the Action when the AI produced no review.json. Identifiers are optional but recommended. */
export const IngestNoOutputSchema = z.object({
  error: z.literal('no_output'),
  repo: z.string().optional(),
  pr_number: z.number().int().optional(),
  head_sha: z.string().optional(),
  message: z.string().max(1000).optional(),
});

/** POST /api/ingest/review (Bearer rit_…) */
export const IngestRequest = z.union([ReviewResultSchema, IngestNoOutputSchema]);
export type IngestRequest = z.infer<typeof IngestRequest>;

/** 202 accepted (finalize queued) or 200 duplicate. */
export const IngestResponse = z.object({
  reviewId: Id,
  duplicate: z.boolean().default(false),
});

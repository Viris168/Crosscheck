import { z } from 'zod';
import { Category, Severity } from './enums';

/** schema v1 — the ONE format every provider returns. */
export const IssueSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(Severity),
  category: z.enum(Category),
  title: z.string().max(200),
  explanation: z.string().max(4000),
  suggested_fix: z.string().max(8000).optional(),
});

export const ReviewResultSchema = z.object({
  schema_version: z.literal(1),
  repo: z.string(),
  pr_number: z.number().int(),
  head_sha: z.string(),
  model: z.string().optional(),
  risk_score: z.number().min(0).max(100),
  summary: z.string().max(4000),
  issues: z.array(IssueSchema).max(200),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewIssue = z.infer<typeof IssueSchema>;

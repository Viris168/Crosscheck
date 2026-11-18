import { z } from 'zod';
import { Category, Severity } from '../enums';
import { RiskLevel } from '../risk';
import { Id } from './common';

export const OrgParams = z.object({ orgId: Id });

/** GET /api/orgs/:orgId/overview?range=30d|90d */
export const OverviewQuery = z.object({
  range: z.enum(['30d', '90d']).default('30d'),
});

export const OverviewResponse = z.object({
  range: z.enum(['30d', '90d']),
  totals: z.object({
    repos: z.number().int().nonnegative(),
    openPulls: z.number().int().nonnegative(),
    reviews: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    avgRiskScore: z.number().nullable(),
  }),
  /** Open PRs bucketed by the risk level of their latest review. */
  openPullsByRiskLevel: z.record(z.enum([...RiskLevel, 'unreviewed']), z.number().int()),
  /** One point per day (YYYY-MM-DD) in the range. */
  riskOverTime: z.array(
    z.object({
      date: z.iso.date(),
      reviews: z.number().int().nonnegative(),
      avgRiskScore: z.number().nullable(),
    }),
  ),
  issuesByCategory: z.record(z.enum(Category), z.number().int()),
  issuesBySeverity: z.record(z.enum(Severity), z.number().int()),
});

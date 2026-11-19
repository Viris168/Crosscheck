import { z } from 'zod';
import { Category, MemberRole, Severity } from '../enums';
import { RiskLevel } from '../risk';
import { Id } from './common';

export const OrgParams = z.object({ orgId: Id });

/** PATCH /api/orgs/:orgId/members/:memberId */
export const MemberParams = z.object({ orgId: Id, memberId: Id });

/** A member of our org. Members come from GitHub; `login` is null for a user without a GitHub login. */
export const OrgMemberSchema = z.object({
  id: Id,
  userId: Id,
  login: z.string().nullable(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(MemberRole),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;

/** GET /api/orgs/:orgId/members — any member. */
export const ListMembersResponse = z.object({
  members: z.array(OrgMemberSchema),
  /** true until the client accepts the GitHub App's Members: read permission. */
  needsMemberPermission: z.boolean(),
});

/** PATCH /api/orgs/:orgId/members/:memberId — owner only; the org always keeps one owner (409). */
export const UpdateMemberBody = z.object({ role: z.enum(MemberRole) });
export const UpdateMemberResponse = z.object({ member: OrgMemberSchema });

/** POST /api/me/sync-orgs — org ids joined / left by this sync. */
export const SyncOrgsResponse = z.object({
  joined: z.array(Id),
  left: z.array(Id),
});

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

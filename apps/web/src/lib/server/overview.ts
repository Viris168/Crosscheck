import 'server-only';
import { prisma } from '@app/db';
import { Category, RiskLevel, Severity, type OverviewResponse } from '@app/shared';
import type { z } from 'zod';

type Overview = z.input<typeof OverviewResponse>;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const avg = (xs: number[]) =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;

/** GET /api/orgs/:orgId/overview — aggregates for the org dashboard. */
export async function buildOverview(
  orgId: string,
  range: '30d' | '90d',
  now = new Date(),
): Promise<Overview> {
  const days = range === '90d' ? 90 : 30;
  // Day buckets are UTC; the range covers `days` calendar days ending today.
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(todayStart - (days - 1) * DAY_MS);
  const inOrg = { pullRequest: { repo: { orgId } } };
  const inRange = { ...inOrg, createdAt: { gte: since } };

  const [repos, openPulls, reviews, byCategory, bySeverity] = await Promise.all([
    prisma.repo.count({ where: { orgId } }),
    prisma.pullRequest.findMany({
      where: { state: 'open', repo: { orgId } },
      select: {
        // Latest review that produced a risk level.
        reviews: {
          where: { riskLevel: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { riskLevel: true },
        },
      },
    }),
    prisma.review.findMany({
      where: inRange,
      select: { status: true, riskScore: true, createdAt: true },
    }),
    prisma.issue.groupBy({ by: ['category'], where: { review: inRange }, _count: { _all: true } }),
    prisma.issue.groupBy({ by: ['severity'], where: { review: inRange }, _count: { _all: true } }),
  ]);

  const openPullsByRiskLevel = Object.fromEntries(
    [...RiskLevel, 'unreviewed'].map((k) => [k, 0]),
  ) as Overview['openPullsByRiskLevel'];
  for (const pr of openPulls) {
    const level = pr.reviews[0]?.riskLevel ?? 'unreviewed';
    openPullsByRiskLevel[level] = (openPullsByRiskLevel[level] ?? 0) + 1;
  }

  const perDay = new Map<string, { reviews: number; scores: number[] }>();
  for (let i = 0; i < days; i++) {
    perDay.set(isoDay(new Date(since.getTime() + i * DAY_MS)), { reviews: 0, scores: [] });
  }
  const completedScores: number[] = [];
  for (const r of reviews) {
    const bucket = perDay.get(isoDay(r.createdAt));
    if (bucket) bucket.reviews += 1;
    if (r.status === 'completed' && r.riskScore != null) {
      bucket?.scores.push(r.riskScore);
      completedScores.push(r.riskScore);
    }
  }

  const issuesByCategory = Object.fromEntries(Category.map((c) => [c, 0])) as Record<
    Category,
    number
  >;
  for (const row of byCategory) issuesByCategory[row.category] = row._count._all;
  const issuesBySeverity = Object.fromEntries(Severity.map((s) => [s, 0])) as Record<
    Severity,
    number
  >;
  for (const row of bySeverity) issuesBySeverity[row.severity] = row._count._all;

  return {
    range,
    totals: {
      repos,
      openPulls: openPulls.length,
      reviews: reviews.length,
      completed: reviews.filter((r) => r.status === 'completed').length,
      failed: reviews.filter((r) => r.status === 'failed').length,
      issues: Object.values(issuesByCategory).reduce((a, b) => a + b, 0),
      avgRiskScore: avg(completedScores),
    },
    openPullsByRiskLevel,
    riskOverTime: [...perDay].map(([date, b]) => ({
      date,
      reviews: b.reviews,
      avgRiskScore: avg(b.scores),
    })),
    issuesByCategory,
    issuesBySeverity,
  };
}

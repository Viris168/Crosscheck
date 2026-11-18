import { OverviewResponse } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  repo: { count: vi.fn() },
  pullRequest: { findMany: vi.fn() },
  review: { findMany: vi.fn() },
  issue: { groupBy: vi.fn() },
}));
vi.mock('@app/db', () => ({ prisma }));

const { buildOverview } = await import('./overview');

describe('buildOverview', () => {
  it('aggregates totals, risk buckets, per-day series and issue counts', async () => {
    const now = new Date('2026-11-18T15:00:00Z');
    prisma.repo.count.mockResolvedValue(2);
    prisma.pullRequest.findMany.mockResolvedValue([
      { reviews: [{ riskLevel: 'high' }] },
      { reviews: [] },
      { reviews: [{ riskLevel: 'high' }] },
    ]);
    prisma.review.findMany.mockResolvedValue([
      { status: 'completed', riskScore: 60, createdAt: new Date('2026-11-18T01:00:00Z') },
      { status: 'completed', riskScore: 41, createdAt: new Date('2026-11-18T09:00:00Z') },
      { status: 'failed', riskScore: null, createdAt: new Date('2026-11-17T09:00:00Z') },
      { status: 'running', riskScore: null, createdAt: new Date('2026-10-20T00:00:00Z') },
    ]);
    prisma.issue.groupBy
      .mockResolvedValueOnce([{ category: 'security', _count: { _all: 3 } }])
      .mockResolvedValueOnce([{ severity: 'high', _count: { _all: 3 } }]);

    const o = OverviewResponse.parse(await buildOverview('org1', '30d', now));
    expect(o.totals).toEqual({
      repos: 2,
      openPulls: 3,
      reviews: 4,
      completed: 2,
      failed: 1,
      issues: 3,
      avgRiskScore: 50.5,
    });
    expect(o.openPullsByRiskLevel).toEqual({
      low: 0,
      medium: 0,
      high: 2,
      critical: 0,
      unreviewed: 1,
    });
    expect(o.riskOverTime).toHaveLength(30);
    expect(o.riskOverTime[0]?.date).toBe('2026-10-20');
    expect(o.riskOverTime.at(-1)).toEqual({ date: '2026-11-18', reviews: 2, avgRiskScore: 50.5 });
    expect(o.riskOverTime.at(-2)).toEqual({ date: '2026-11-17', reviews: 1, avgRiskScore: null });
    expect(o.issuesByCategory).toEqual({ security: 3, bug: 0, performance: 0, style: 0, test: 0 });

    // Org-scoped, range-scoped queries.
    const where = prisma.review.findMany.mock.calls[0]![0].where;
    expect(where.pullRequest).toEqual({ repo: { orgId: 'org1' } });
    expect(where.createdAt.gte.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });
});

'use client';

import { Category, RiskLevel, type OverviewResponse } from '@app/shared/client';
import { useState } from 'react';
import type { z } from 'zod';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/skeleton';
import { useOverview } from '@/hooks/use-overview';
import { RISK_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { RiskChart } from './risk-chart';

type Overview = z.infer<typeof OverviewResponse>;

const RISK_BAR: Record<RiskLevel | 'unreviewed', string> = {
  low: 'bg-green-500',
  medium: 'bg-amber-400',
  high: 'bg-orange-500',
  critical: 'bg-red-600',
  unreviewed: 'bg-neutral-300',
};

export function OrgOverview({ orgId }: { orgId: string }) {
  const [range, setRange] = useState<'30d' | '90d'>('30d');
  const { data, error, isPending } = useOverview(orgId, range);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <div role="group" aria-label="Time range" className="flex gap-1">
          {(['30d', '90d'] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === range ? 'default' : 'outline'}
              aria-pressed={r === range}
              onClick={() => setRange(r)}
            >
              Last {r === '30d' ? 30 : 90} days
            </Button>
          ))}
        </div>
      </div>
      {isPending ? (
        <LoadingState label="Loading overview…" />
      ) : error ? (
        <QueryError error={error} what="organization" />
      ) : (
        <OverviewBody data={data} />
      )}
    </div>
  );
}

function OverviewBody({ data }: { data: Overview }) {
  const t = data.totals;
  const tiles = [
    { label: 'Repositories', value: t.repos },
    { label: 'Open PRs', value: t.openPulls },
    { label: 'Reviews', value: t.reviews },
    { label: 'Failed reviews', value: t.failed },
    { label: 'Issues found', value: t.issues },
    { label: 'Avg. risk score', value: t.avgRiskScore ?? '—' },
  ];
  const riskRows = [...RiskLevel, 'unreviewed' as const].map((k) => ({
    key: k,
    label: k === 'unreviewed' ? 'Not reviewed' : RISK_LABEL[k],
    value: data.openPullsByRiskLevel[k] ?? 0,
  }));
  const categories = Category.map((c) => ({
    key: c,
    label: c,
    value: data.issuesByCategory[c] ?? 0,
  })).sort((a, b) => b.value - a.value);

  return (
    <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <Card key={tile.label} className="px-4 py-3">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{tile.value}</dd>
          </Card>
        ))}
      </dl>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Open PRs by risk level</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={riskRows} colorOf={(k) => RISK_BAR[k as keyof typeof RISK_BAR]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Most common issue categories</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={categories} colorOf={() => 'bg-blue-500'} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Risk over time</CardTitle>
        </CardHeader>
        <CardContent>
          <RiskChart points={data.riskOverTime} />
        </CardContent>
      </Card>
    </>
  );
}

function BarList({
  rows,
  colorOf,
}: {
  rows: { key: string; label: string; value: number }[];
  colorOf: (key: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[8rem_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="capitalize">{r.label}</span>
          <span className="h-2 rounded-full bg-secondary" aria-hidden>
            <span
              className={cn('block h-full rounded-full', colorOf(r.key))}
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

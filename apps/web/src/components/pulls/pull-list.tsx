'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { DiffStat, RiskBadge, StaleBadge, StatusChip } from '@/components/chips';
import { QueryError } from '@/components/query-error';
import { LinkTabs } from '@/components/ui/link-tabs';
import { LoadingState } from '@/components/ui/skeleton';
import { usePulls, type PullStateFilter } from '@/hooks/use-pulls';

const STATES: { value: PullStateFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export function PullList({ repoId }: { repoId: string }) {
  const params = useSearchParams();
  const raw = params.get('state');
  const state: PullStateFilter = raw === 'closed' || raw === 'all' ? raw : 'open';
  const { data, error, isPending } = usePulls(repoId, state);
  const base = `/repos/${repoId}/pulls`;

  return (
    <div className="flex flex-col gap-4">
      <LinkTabs
        label="Pull request state"
        tabs={STATES.map((s) => ({
          href: `${base}?state=${s.value}`,
          label: s.label,
          active: s.value === state,
        }))}
      />
      {isPending ? (
        <LoadingState label="Loading pull requests…" />
      ) : error ? (
        <QueryError error={error} what="repository" />
      ) : data.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No {state === 'all' ? '' : `${state} `}pull requests.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {data.map((p) => (
            <li key={p.id}>
              <Link
                href={`${base}/${p.number}`}
                className="flex flex-col gap-2 px-4 py-3 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 sm:flex-row sm:items-center"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{p.title}</span>
                  <span className="text-xs text-muted-foreground">
                    #{p.number} · {p.author} · {p.state}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {p.latestReview?.riskLevel && (
                    <RiskBadge level={p.latestReview.riskLevel} score={p.latestReview.riskScore} />
                  )}
                  <DiffStat additions={p.additions} deletions={p.deletions} />
                  <span className="text-xs text-muted-foreground">{p.changedFiles} files</span>
                  {p.latestReview ? (
                    <StatusChip status={p.latestReview.status} />
                  ) : (
                    <span className="text-xs text-muted-foreground">Not reviewed</span>
                  )}
                  {p.latestReview?.stale && <StaleBadge />}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

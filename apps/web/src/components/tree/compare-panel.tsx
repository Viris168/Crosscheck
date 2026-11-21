'use client';

import type { TreeSnapshot } from '@app/shared/client';
import { ArrowLeftRight } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTreeCompare } from '@/hooks/use-tree';
import { ApiError } from '@/lib/api-client';
import { shortSha, type TreeGraph } from './layout';
import type { Selection } from './tree-svg';

/** Any two branches: ahead / behind / merge base, from GET /tree/compare (T6b "Do" 4). */
export function ComparePanel({
  repoId,
  snapshot,
  graph,
  a,
  b,
  onSelect,
}: {
  repoId: string;
  snapshot: TreeSnapshot;
  graph: TreeGraph;
  a: string;
  b: string;
  onSelect: (s: Selection) => void;
}) {
  const q = useTreeCompare(repoId, a, b);
  const names = new Set(snapshot.branches.map((x) => x.name));
  if (!names.has(a) || !names.has(b))
    return <p className="text-sm text-muted-foreground">One of these branches no longer exists.</p>;

  return (
    <>
      <h2 className="mb-3 flex flex-wrap items-center gap-1.5 text-[15px] font-semibold">
        Compare <Name>{a}</Name> with <Name>{b}</Name>
      </h2>
      {q.isPending ? (
        <div role="status" aria-label="Comparing" className="flex flex-col gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-5 w-64" />
        </div>
      ) : q.isError ? (
        <Alert tone="error">
          {q.error instanceof ApiError && q.error.status === 409
            ? q.error.message
            : 'Could not compare these branches. Try again.'}
        </Alert>
      ) : (
        <dl
          className="grid grid-cols-[120px_1fr] gap-x-2.5 gap-y-1 text-sm"
          data-testid="compare-result"
        >
          <dt className="text-muted-foreground">Ahead</dt>
          <dd className="m-0 tabular-nums">
            ↑{q.data.ahead} commit{q.data.ahead === 1 ? '' : 's'} on {a} not on {b}
          </dd>
          <dt className="text-muted-foreground">Behind</dt>
          <dd className="m-0 tabular-nums">
            ↓{q.data.behind} commit{q.data.behind === 1 ? '' : 's'} on {b} not on {a}
          </dd>
          <dt className="text-muted-foreground">Merge base</dt>
          <dd className="m-0">
            {q.data.mergeBase === null ? (
              'none (unrelated histories)'
            ) : graph.commit(q.data.mergeBase) ? (
              <button
                type="button"
                onClick={() => onSelect({ type: 'commit', sha: q.data.mergeBase! })}
                className="cursor-pointer rounded bg-(--t-chip) px-1.5 py-px font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-(--t-accent)"
                aria-label={`Commit ${shortSha(q.data.mergeBase)}`}
              >
                {shortSha(q.data.mergeBase)}
              </button>
            ) : (
              <code className="rounded bg-(--t-chip) px-1.5 py-px font-mono text-[12.5px]">
                {shortSha(q.data.mergeBase)}
              </code>
            )}
          </dd>
        </dl>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onSelect({ type: 'compare', a: b, b: a })}
        >
          <ArrowLeftRight aria-hidden /> Swap
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onSelect({ type: 'branch', name: a })}>
          Back to {a.length > 20 ? `${a.slice(0, 19)}…` : a}
        </Button>
      </div>
    </>
  );
}

function Name({ children }: { children: string }) {
  return (
    <code className="rounded bg-(--t-chip) px-1.5 py-px font-mono text-[12.5px]">{children}</code>
  );
}

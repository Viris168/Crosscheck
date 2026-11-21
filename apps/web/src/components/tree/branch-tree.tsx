'use client';

import type { ErrorCode, GetTreeResponse } from '@app/shared/client';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { QueryError } from '@/components/query-error';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSyncTree, useTree } from '@/hooks/use-tree';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { layoutTree, TreeGraph } from './layout';
import { TreeDetails } from './tree-details';
import { TreeSvg, type Selection } from './tree-svg';

// The prototype's colour tokens, as CSS variables scoped to the tree (light + `.dark`). Panel, text,
// muted and border come from our theme (--card, --foreground, --muted-foreground, --border).
const TOKENS =
  '[--t-accent:#534AB7] [--t-accent-bg:#EEEDFE] [--t-ok:#0F6E56] [--t-ok-bg:#E1F5EE] ' +
  '[--t-fail:#A32D2D] [--t-fail-bg:#FCEBEB] [--t-warn:#854F0B] [--t-warn-bg:#FAEEDA] ' +
  '[--t-line:#b4b2a9] [--t-chip:#f1efe8] ' +
  'dark:[--t-accent:#AFA9EC] dark:[--t-accent-bg:#3C3489] dark:[--t-ok:#9FE1CB] dark:[--t-ok-bg:#085041] ' +
  'dark:[--t-fail:#F7C1C1] dark:[--t-fail-bg:#791F1F] dark:[--t-warn:#FAC775] dark:[--t-warn-bg:#633806] ' +
  'dark:[--t-line:#5F5E5A] dark:[--t-chip:#2f2f2c]';

const FAILURE: Partial<Record<ErrorCode, string>> = {
  github_error: 'GitHub did not answer while we read this repository.',
  timeout: 'Reading the commit history took too long.',
  rate_limited: 'GitHub rate-limited us while reading this repository.',
};

/** The snapshot can only show squares once it says which commits are squash merges (contract request). */
const NO_SQUASH: ReadonlySet<string> = new Set();

export function BranchTree({ repoId, repoFullName }: { repoId: string; repoFullName: string }) {
  const tree = useTree(repoId);
  const sync = useSyncTree(repoId);

  const syncError =
    sync.error instanceof ApiError && sync.error.status === 429
      ? 'Refreshed less than a minute ago. Try again soon.'
      : sync.error
        ? 'Could not start a refresh. Try again.'
        : null;

  const header = (data?: GetTreeResponse) => (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <h2 className="mr-auto text-[15px] font-semibold">Repository tree</h2>
      {data?.status === 'syncing' && data.snapshot && (
        <span role="status" className="text-xs text-muted-foreground">
          Updating…
        </span>
      )}
      {data?.syncedAt && (
        <span className="text-xs text-muted-foreground">
          Synced {new Date(data.syncedAt).toLocaleString()}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => sync.mutate()}
        disabled={sync.isPending || data?.status === 'syncing'}
      >
        <RefreshCw aria-hidden /> Refresh
      </Button>
    </div>
  );

  if (tree.isPending) {
    return (
      <Card className={TOKENS}>
        <Syncing label="Loading the branch tree…" />
      </Card>
    );
  }
  if (tree.isError) return <QueryError error={tree.error} what="repository" />;

  const data = tree.data;
  return (
    <div className={`flex flex-col gap-4 ${TOKENS}`}>
      {syncError && <Alert tone="error">{syncError}</Alert>}
      {data.status === 'failed' && (
        <Alert tone="error" className="items-center">
          <span className="mr-auto">
            Could not build the branch tree.{' '}
            {(data.errorCode && FAILURE[data.errorCode]) ?? 'Something went wrong on our side.'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
          >
            Try again
          </Button>
        </Alert>
      )}
      {data.snapshot ? (
        <TreeBody
          data={data}
          snapshot={data.snapshot}
          header={header(data)}
          repoId={repoId}
          repoFullName={repoFullName}
        />
      ) : data.status === 'failed' ? null : (
        <Card>
          {header(data)}
          <Syncing label="Cloning commits…" />
        </Card>
      )}
    </div>
  );
}

function TreeBody({
  data,
  snapshot,
  header,
  repoId,
  repoFullName,
}: {
  data: GetTreeResponse;
  snapshot: NonNullable<GetTreeResponse['snapshot']>;
  header: ReactNode;
  repoId: string;
  repoFullName: string;
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection>({ type: 'repo' });
  const graph = useMemo(() => new TreeGraph(snapshot.commits), [snapshot]);
  const layout = useMemo(() => layoutTree(snapshot, graph, NO_SQUASH), [snapshot, graph]);
  const repoName = repoFullName.split('/').pop() ?? repoFullName;

  const onEnter = (s: Selection) => {
    if (s.type !== 'branch') return false;
    const pr = snapshot.branches.find((b) => b.name === s.name)?.pr;
    if (!pr) return false;
    router.push(`/repos/${encodeURIComponent(repoId)}/pulls/${pr.number}`);
    return true;
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        {snapshot.truncated && (
          <Alert tone="warning">
            This repository is large, so only part of its history is drawn. Counts (↑ ahead, ↓
            behind) are still exact.
          </Alert>
        )}
        <Card>
          {header}
          {snapshot.branches.length <= 1 && (
            <p className="mb-3 text-sm text-muted-foreground">
              Only the default branch so far. Other branches show up here once they are pushed.
            </p>
          )}
          <div className="overflow-x-auto">
            <TreeSvg
              layout={layout}
              repoName={repoName}
              selection={selection}
              onSelect={setSelection}
              onEnter={onEnter}
            />
          </div>
          <Legend />
        </Card>
      </div>
      <aside>
        <Card aria-live="polite">
          <TreeDetails
            snapshot={snapshot}
            graph={graph}
            selection={selection}
            onSelect={setSelection}
            repoId={repoId}
            repoFullName={repoFullName}
            syncedAt={data.syncedAt}
          />
        </Card>
      </aside>
    </div>
  );
}

function Card({ className = '', ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={`rounded-xl border bg-card p-4 text-card-foreground ${className}`}
      {...props}
    />
  );
}

function Syncing({ label }: { label: string }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-14 w-60" />
          <Skeleton className="h-5 w-5 rounded-full" />
          <Skeleton className="h-5 w-5 rounded-full" />
          <Skeleton className="h-5 w-5 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function Dot({ style, className = '' }: { style: CSSProperties; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('mr-1.5 inline-block size-2.5 rounded-full align-[-1px]', className)}
      style={style}
    />
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-3.5 text-xs text-muted-foreground">
      <span>
        <Dot style={{ border: '2px solid var(--t-accent)' }} />
        commit
      </span>
      <span>
        <Dot style={{ background: 'var(--t-accent)' }} />
        merge commit
      </span>
      <span>
        <Dot className="size-3.5" style={{ border: '2px double var(--t-accent)' }} />
        branch head
      </span>
      <span>
        <Dot className="rounded-[3px]" style={{ border: '2px solid var(--t-accent)' }} />
        squash commit
      </span>
      <span>↑ ahead / ↓ behind the branch it is compared with, and why that branch</span>
      <span>
        <Dot style={{ background: 'var(--t-ok)' }} />
        CI passed <Dot className="ml-2" style={{ background: 'var(--t-fail)' }} />
        failed <Dot className="ml-2" style={{ background: 'var(--t-warn)' }} />
        pending
      </span>
    </div>
  );
}

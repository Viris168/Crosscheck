'use client';

import type { ErrorCode } from '@app/shared/client';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { QueryError } from '@/components/query-error';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSyncTree, useTree, VISIBLE_DEBOUNCE_MS, type TreeData } from '@/hooks/use-tree';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { LastUpdated } from './last-updated';
import { fullRowWidth, layoutTree, squashShas, TreeGraph, type RowRange } from './layout';
import { TreeDetails } from './tree-details';
import {
  TreeSvg,
  VirtualTree,
  type SelectOptions,
  type Selection,
  type Viewport,
} from './tree-svg';
import { TreeToolbar } from './tree-toolbar';
import { useRowChanges } from './use-row-changes';
import { useTreeView } from './use-tree-view';
import { isFiltering, viewRows, type MatchContext, type ViewRow } from './view';

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

// VERIFY: GitHub's page for accepting an App's updated permissions (also linked from docs/deploy.md
// → "Upgrading an existing install").
export const APP_PERMISSIONS_DOC =
  'https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app';

export function BranchTree({ repoId, repoFullName }: { repoId: string; repoFullName: string }) {
  // Branch names on screen (virtualized rows); GET /tree computes their counts if the snapshot lacks them.
  const [visible, setVisibleState] = useState<readonly string[]>([]);
  const setVisible = useCallback(
    (next: readonly string[]) =>
      setVisibleState((prev) => (prev.join('\n') === next.join('\n') ? prev : next)),
    [],
  );
  const tree = useTree(repoId, { visible });
  const sync = useSyncTree(repoId);

  const syncError =
    sync.error instanceof ApiError && sync.error.status === 429
      ? 'Refreshed less than a minute ago. Try again soon.'
      : sync.error
        ? 'Could not start a refresh. Try again.'
        : null;

  const header = (data?: TreeData) => (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <h2 className="mr-auto text-[15px] font-semibold">Repository tree</h2>
      {data?.status === 'syncing' && data.snapshot && (
        <span role="status" className="text-xs text-muted-foreground">
          Updating…
        </span>
      )}
      {data?.syncedAt && <LastUpdated at={data.syncedAt} />}
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
      {data.snapshot && data.liveEvents === false && data.status !== 'syncing' && (
        <p data-testid="live-hint" className="text-xs text-muted-foreground">
          No push events from GitHub yet, so this tree refreshes every 15 minutes, not live.{' '}
          <a
            href={APP_PERMISSIONS_DOC}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Accept the GitHub App&apos;s new permissions
          </a>{' '}
          to update it within seconds of a push.
        </p>
      )}
      {data.snapshot ? (
        <TreeBody
          data={data}
          snapshot={data.snapshot}
          header={header(data)}
          repoId={repoId}
          repoFullName={repoFullName}
          onVisible={setVisible}
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

const toggled = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

function TreeBody({
  data,
  snapshot: latest,
  header,
  repoId,
  repoFullName,
  onVisible,
}: {
  data: TreeData;
  snapshot: NonNullable<TreeData['snapshot']>;
  header: ReactNode;
  repoId: string;
  repoFullName: string;
  onVisible: (names: readonly string[]) => void;
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection>({ type: 'repo' });
  const [view, setView] = useTreeView();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [mergedOpen, setMergedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [runs, setRuns] = useState<ReadonlySet<string>>(() => new Set());
  const [now] = useState(() => Date.now());
  // Live updates: draw the latest snapshot, animating rows whose head moved, new and deleted rows.
  const { shown: snapshot, changes } = useRowChanges(latest);
  const graph = useMemo(() => new TreeGraph(snapshot.commits), [snapshot]);
  const squash = useMemo(() => squashShas(snapshot), [snapshot]);
  const minePrs = data.minePrs;
  const ctx = useMemo<MatchContext>(
    () => ({
      minePrs: new Set(minePrs ?? []),
      headTime: (sha) => {
        const t = Date.parse(graph.commit(sha)?.committedAt ?? '');
        return Number.isFinite(t) ? t : null;
      },
      now,
    }),
    [minePrs, graph, now],
  );
  const rows = useMemo(
    () => viewRows(snapshot, { view, ctx, collapsed, mergedOpen }),
    [snapshot, view, ctx, collapsed, mergedOpen],
  );
  const repoName = repoFullName.split('/').pop() ?? repoFullName;
  const filtering = isFiltering(view);
  const matched = filtering
    ? rows.filter((r) => r.kind === 'branch' && !r.context).length
    : snapshot.branches.length;

  const onSelect = useCallback((s: Selection, opts?: SelectOptions) => {
    setSelection((cur) => {
      if (opts?.compare && s.type === 'branch') {
        if (cur.type === 'branch' && cur.name !== s.name)
          return { type: 'compare', a: cur.name, b: s.name };
        if (cur.type === 'compare' && cur.a !== s.name)
          return { type: 'compare', a: cur.a, b: s.name };
      }
      return s;
    });
  }, []);

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
          {snapshot.branches.length > 1 && (
            <TreeToolbar
              view={view}
              onChange={setView}
              shown={matched}
              total={snapshot.branches.length}
            />
          )}
          {snapshot.branches.length <= 1 && (
            <p className="mb-3 text-sm text-muted-foreground">
              Only the default branch so far. Other branches show up here once they are pushed.
            </p>
          )}
          {filtering && rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No branches match. Try another name or fewer filters.
            </p>
          ) : (
            <VirtualTree count={rows.length}>
              {(r, viewport) => (
                <TreeLayer
                  snapshot={snapshot}
                  graph={graph}
                  squash={squash}
                  rows={rows}
                  runs={runs}
                  range={r}
                  viewport={viewport}
                  onVisible={onVisible}
                  repoName={repoName}
                  selection={selection}
                  onSelect={onSelect}
                  onEnter={onEnter}
                  onToggleSubtree={(n) => setCollapsed((c) => toggled(c, n))}
                  onToggleMerged={(p) => setMergedOpen((m) => toggled(m, p))}
                  onToggleRun={(n) => setRuns((x) => toggled(x, n))}
                  changes={changes}
                />
              )}
            </VirtualTree>
          )}
          <Legend />
        </Card>
      </div>
      <aside>
        <Card aria-live="polite">
          <TreeDetails
            snapshot={snapshot}
            graph={graph}
            selection={selection}
            onSelect={onSelect}
            repoId={repoId}
            repoFullName={repoFullName}
            syncedAt={data.syncedAt}
            canEdit={data.canEdit}
          />
        </Card>
      </aside>
    </div>
  );
}

/** Lays out only the rows in `range` (their commits are the costly part) and draws them. */
function TreeLayer({
  snapshot,
  graph,
  squash,
  rows,
  runs,
  range,
  viewport,
  onVisible,
  ...svg
}: {
  snapshot: NonNullable<TreeData['snapshot']>;
  graph: TreeGraph;
  squash: ReadonlySet<string>;
  rows: ViewRow[];
  runs: ReadonlySet<string>;
  range: RowRange;
  viewport: Viewport;
  onVisible: (names: readonly string[]) => void;
} & Omit<ComponentProps<typeof TreeSvg>, 'layout' | 'range' | 'viewport' | 'width'>) {
  const { start, end } = range;
  const layout = useMemo(
    () => layoutTree(snapshot, graph, squash, { rows, expanded: runs, range: { start, end } }),
    [snapshot, graph, squash, rows, runs, start, end],
  );
  // Rows on screen → useTree, once scrolling settles. A timer, not a state update during the scroll,
  // so the virtualizer's flushSync renders never cascade into the parents.
  const visibleKey = rows
    .slice(start, end)
    .flatMap((r) => (r.kind === 'branch' ? [r.branch.name] : []))
    .join('\n');
  useEffect(() => {
    const t = setTimeout(
      () => onVisible(visibleKey ? visibleKey.split('\n') : []),
      VISIBLE_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [visibleKey, onVisible]);
  // Virtualized: keep at least a full row's width so the canvas does not narrow while scrolling.
  const width = end - start < rows.length ? Math.max(layout.width, fullRowWidth()) : layout.width;
  return <TreeSvg layout={layout} range={range} viewport={viewport} width={width} {...svg} />;
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

'use client';

import type { BranchNode, TreeSnapshot } from '@app/shared/client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Select } from '@/components/ui/input';
import { ComparePanel } from './compare-panel';
import { CompareWithSelect } from './compare-with-select';
import { branchesContaining, mergedLong, shortSha, whyLong, type TreeGraph } from './layout';
import { isComputed } from './scale-contract';
import { RECORDED_TIP, type Selection } from './tree-svg';

const CI_TONE: Record<BranchNode['ci'], string> = {
  success: 'bg-(--t-ok-bg) text-(--t-ok)',
  failure: 'bg-(--t-fail-bg) text-(--t-fail)',
  pending: 'bg-(--t-warn-bg) text-(--t-warn)',
  neutral: 'bg-(--t-chip) text-muted-foreground',
  none: 'bg-(--t-chip) text-muted-foreground',
};

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-(--t-chip) px-1.5 py-px font-mono text-[12.5px]">{children}</code>
  );
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-2.5 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="m-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TreeDetails({
  snapshot,
  graph,
  selection,
  onSelect,
  repoId,
  repoFullName,
  syncedAt,
  canEdit = false,
}: {
  snapshot: TreeSnapshot;
  graph: TreeGraph;
  selection: Selection;
  onSelect: (s: Selection) => void;
  repoId: string;
  repoFullName: string;
  syncedAt: string | null;
  /** Write access: shows the "Compare with" select. */
  canEdit?: boolean;
}) {
  // VERIFY: github.com only (no GitHub Enterprise host is stored on Repo).
  const ghCommit = (sha: string) =>
    `https://github.com/${repoFullName.split('/').map(encodeURIComponent).join('/')}/commit/${sha}`;
  const pullHref = (n: number) => `/repos/${encodeURIComponent(repoId)}/pulls/${n}`;
  const shaButton = (sha: string) => (
    <button
      key={sha}
      type="button"
      onClick={() => onSelect({ type: 'commit', sha })}
      className="mr-1 cursor-pointer rounded bg-(--t-chip) px-1.5 py-px font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-(--t-accent)"
      aria-label={`Commit ${shortSha(sha)}`}
    >
      {shortSha(sha)}
    </button>
  );

  if (selection.type === 'compare') {
    return (
      <ComparePanel
        key={`${selection.a}\n${selection.b}`}
        repoId={repoId}
        snapshot={snapshot}
        graph={graph}
        a={selection.a}
        b={selection.b}
        onSelect={onSelect}
      />
    );
  }

  if (selection.type === 'commit') {
    const c = graph.commit(selection.sha);
    if (!c)
      return <p className="text-sm text-muted-foreground">This commit is no longer in the tree.</p>;
    const type =
      c.parents.length > 1 ? 'Merge commit' : c.parents.length ? 'Normal commit' : 'Root commit';
    const on = branchesContaining(snapshot, graph, c.sha);
    return (
      <>
        <h2 className="mb-3 text-[15px] font-semibold">
          Commit <Code>{shortSha(c.sha)}</Code>
        </h2>
        <Kv
          rows={[
            [
              'SHA',
              <span key="s" className="font-mono text-xs break-all">
                {c.sha}
              </span>,
            ],
            ['Type', type],
            ['Committed', new Date(c.committedAt).toLocaleString()],
            ['Parents', c.parents.length ? c.parents.map(shaButton) : '–'],
            [
              'On branches',
              on.length
                ? on.map((b) => (
                    <span key={b} className="mr-1">
                      <Code>{b}</Code>
                    </span>
                  ))
                : '–',
            ],
          ]}
        />
        <a
          href={ghCommit(c.sha)}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-block text-sm font-medium underline-offset-4 hover:underline"
        >
          View on GitHub ↗
        </a>
        <p className="mt-2 text-xs text-muted-foreground">
          Commit messages and authors are not stored here; GitHub shows them.
        </p>
      </>
    );
  }

  if (selection.type === 'branch') {
    const b = snapshot.branches.find((x) => x.name === selection.name);
    if (!b) return <p className="text-sm text-muted-foreground">This branch no longer exists.</p>;
    const rows: [string, ReactNode][] = [
      ['Head', shaButton(b.headSha)],
      [
        'Compared with',
        b.compareWith ? (
          <>
            <Code>{b.compareWith}</Code>
            {b.recorded && (
              <span
                title={RECORDED_TIP}
                className="ml-1.5 inline-block rounded-full bg-[var(--t-accent-bg)] px-2 py-0.5 text-xs font-medium text-[var(--t-accent)]"
              >
                recorded
              </span>
            )}
            <span className="block text-xs text-muted-foreground">{whyLong(b, canEdit)}</span>
          </>
        ) : (
          '– (this is the default branch)'
        ),
      ],
    ];
    if (b.compareWith)
      rows.push([
        `vs ${b.compareWith.length > 12 ? `${b.compareWith.slice(0, 11)}…` : b.compareWith}`,
        isComputed(b) ? (
          <span key="ab" className="tabular-nums">
            ↑{b.ahead} ahead, ↓{b.behind} behind
          </span>
        ) : (
          <span key="ab" className="text-muted-foreground">
            counting…
          </span>
        ),
      ]);
    if (!b.isDefault) rows.push(['Merged?', mergedLong(b)]);
    rows.push([
      b.pr?.state === 'open' || !b.pr ? 'Open PR' : 'Latest PR',
      b.pr ? (
        <>
          <Link
            href={pullHref(b.pr.number)}
            className="font-medium underline-offset-4 hover:underline"
          >
            #{b.pr.number}
          </Link>{' '}
          → <Code>{b.pr.baseRef}</Code>{' '}
          <span className="text-muted-foreground">({b.pr.state})</span>
          {b.pr.state === 'open' && (
            <span
              className={`ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CI_TONE[b.ci]}`}
            >
              CI {b.ci}
            </span>
          )}
        </>
      ) : (
        'none'
      ),
    ]);
    return (
      <>
        <h2 className="mb-3 text-[15px] font-semibold">
          Branch <Code>{b.name}</Code>
        </h2>
        <Kv rows={rows} />
        {canEdit && !b.isDefault && (
          <CompareWithSelect key={b.name} repoId={repoId} snapshot={snapshot} branch={b} />
        )}
        <div className="mt-4 border-t pt-3">
          <h3 className="mb-2 text-sm font-semibold">Compare with any branch</h3>
          <Select
            key={b.name}
            aria-label={`Compare ${b.name} with any branch`}
            value=""
            onChange={(e) =>
              e.target.value && onSelect({ type: 'compare', a: b.name, b: e.target.value })
            }
          >
            <option value="">Pick a branch…</option>
            {snapshot.branches
              .filter((x) => x.name !== b.name)
              .map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
          </Select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Or Shift-click another branch in the tree.
          </p>
        </div>
      </>
    );
  }

  const open = snapshot.branches.filter((b) => b.pr?.state === 'open').length;
  const merged = snapshot.branches.filter((b) => b.merged).length;
  return (
    <>
      <h2 className="mb-3 text-[15px] font-semibold">Repository · {repoFullName}</h2>
      <Kv
        rows={[
          ['Default', <Code key="d">{snapshot.defaultBranch}</Code>],
          ['Branches', snapshot.branches.length],
          ['Commits drawn', graph.size],
          ['Open PRs', open],
          ['Merged', merged],
          ['Synced', syncedAt ? new Date(syncedAt).toLocaleString() : '–'],
        ]}
      />
      <p className="mt-3 text-[13px] text-muted-foreground">
        Click a branch or commit in the tree (or Tab to it and press Enter) to see its details.
        Enter on a branch with a pull request opens the PR. Shift-click a second branch to compare
        the two.
      </p>
    </>
  );
}

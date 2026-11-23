'use client';

import type { CiState } from '@app/shared/client';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  G,
  moreLabel,
  short,
  shortSha,
  type BranchRow,
  type GroupRow,
  type Item,
  type RowRange,
  type TreeLayout,
} from './layout';
import { NO_CHANGES, type RowChanges } from './use-row-changes';

export type Selection =
  | { type: 'repo' }
  | { type: 'branch'; name: string }
  | { type: 'commit'; sha: string }
  /** two branches picked (shift-click a second row, or "Compare with any branch" in the details) */
  | { type: 'compare'; a: string; b: string };

/** `compare`: shift/ctrl/cmd was held, so a second branch is added to compare with the selected one. */
export type SelectOptions = { compare?: boolean };

export const CI_COLOR: Record<CiState, string> = {
  success: 'var(--t-ok)',
  failure: 'var(--t-fail)',
  pending: 'var(--t-warn)',
  neutral: 'var(--t-line)',
  none: 'var(--t-line)',
};
const NOTE_COLOR = { ok: 'var(--t-ok)', warn: 'var(--t-warn)', muted: 'var(--muted-foreground)' };

// Focus ring on the node's outline shape (prototype: `g[data-k]:focus-visible>rect`), plus the live
// update animations (T5c): a moved head flashes the branch box, new rows slide in, deleted rows fade.
// Keyframes without an end state animate back to the element's own fill/stroke.
const FOCUS_CSS = `.bt-node{cursor:pointer;outline:none}
.bt-node:focus-visible>.bt-shape{stroke:var(--t-accent);stroke-width:3}
.bt-run>.bt-shape{fill:var(--t-accent-bg);stroke:var(--t-accent)}
.bt-run:hover>.bt-shape{stroke-width:2}
.bt-run>text{fill:var(--t-accent);font-weight:600}
@keyframes bt-flash{from,35%{fill:var(--t-warn-bg);stroke:var(--t-warn)}}
@keyframes bt-enter{from{opacity:0;transform:translateX(-24px)}}
@keyframes bt-fade-in{from{opacity:0}}
@keyframes bt-leave{to{opacity:0}}
.bt-flash>.bt-node>.bt-shape{animation:bt-flash 2s ease-out}
.bt-enter{animation:bt-enter .45s ease-out both}
.bt-leave{animation:bt-leave .4s ease-in forwards;pointer-events:none}
@media (prefers-reduced-motion:reduce){.bt-enter{animation-name:bt-fade-in}}`;

export const RECORDED_TIP = 'Parent recorded when the branch was created';

const BADGE_W = 58;

const TEXT = { fontSize: 13, fontWeight: 600, fill: 'var(--foreground)' } as const;
const SUB = { fontSize: 12, fill: 'var(--muted-foreground)' } as const;
const MONO = {
  fontSize: 11,
  fill: 'var(--muted-foreground)',
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
} as const;

// ------------------------------------------------------------------ virtualized scroller

/** The scroller's height cap; rows beyond it are not in the DOM. */
export const VIEWPORT_MAX_H = 640;
/** Used until the scroller is measured (and in jsdom, which measures everything as 0). */
const FALLBACK_RECT = { width: 1024, height: VIEWPORT_MAX_H };
/** Rows rendered above and below the viewport. */
export const OVERSCAN = 4;
/** Space above row 0's slot: row i's centre is `rowY(i) = TOP + 26 + i * RH`. */
const PAD = G.TOP + 26 - G.RH / 2;

/** Which way the tree grows: branches as rows (commits to the right) or as columns (commits down). */
export type TreeDirection = 'horizontal' | 'vertical';

/** Top-to-bottom geometry: one column per branch, the repo node above, commits below each box. */
export const V = {
  /** column pitch: a branch box plus a gap */
  COL: G.BW + 24,
  /** left padding before the first column */
  LEFT: 24,
  /** top of the branch boxes */
  BY: 110,
  /** box height */
  BH: 58,
  /** first commit (or chip) centre, below the box */
  get ITEM0() {
    return this.BY + this.BH + 40;
  },
  /** commit pitch down a column */
  STEP: 56,
} as const;
export const colX = (i: number) => V.LEFT + i * V.COL + V.COL / 2;
/** Height of a top-to-bottom tree whose longest column has `items` items. */
export const verticalHeight = (items: number) => Math.max(360, V.ITEM0 + items * V.STEP + 10);

/** The scroller's visible window along the list: top/height, or left/width for a vertical tree. */
export type Viewport = { top: number; height: number };

/**
 * Scroll container over the tree: only the rows in view (plus OVERSCAN) are laid out and drawn
 * (`@tanstack/react-virtual`, fixed row height G.RH). `children` gets that row range.
 */
export function VirtualTree({
  count,
  fill = false,
  direction = 'horizontal',
  children,
}: {
  count: number;
  /** 'vertical' scrolls sideways through branch columns */
  direction?: TreeDirection;
  /** grow to the parent's height (full screen) instead of stopping at VIEWPORT_MAX_H */
  fill?: boolean;
  children: (range: RowRange, viewport: Viewport) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // VERIFY: @tanstack/react-virtual v3 options (initialRect, observeElementRect, paddingStart).
  // The compiler skips memoizing this component; it re-renders on scroll by design.
  const across = direction === 'vertical';
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count,
    horizontal: across,
    getScrollElement: () => ref.current,
    estimateSize: () => (across ? V.COL : G.RH),
    paddingStart: across ? V.LEFT : PAD,
    overscan: OVERSCAN,
    initialRect: FALLBACK_RECT,
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : FALLBACK_RECT)),
  });
  const items = v.getVirtualItems();
  const start = items[0]?.index ?? 0;
  const end = (items.at(-1)?.index ?? -1) + 1;
  const viewport = {
    top: v.scrollOffset ?? 0,
    height: (across ? v.scrollRect?.width : v.scrollRect?.height) || FALLBACK_RECT.height,
  };
  return (
    <div
      ref={ref}
      data-testid="tree-scroller"
      className={fill ? 'min-h-0 flex-1 overflow-auto' : 'overflow-auto'}
      style={fill ? undefined : { maxHeight: VIEWPORT_MAX_H }}
    >
      {children({ start, end }, viewport)}
    </div>
  );
}

// ------------------------------------------------------------------ svg

export function TreeSvg({
  layout,
  range,
  viewport,
  repoName,
  selection,
  onSelect,
  onEnter,
  onToggleSubtree,
  onToggleMerged,
  onToggleRun,
  changes = NO_CHANGES,
  width,
  direction = 'horizontal',
}: {
  layout: TreeLayout;
  direction?: TreeDirection;
  /** rows to draw; default all */
  range?: RowRange;
  /** the scroller's visible window: keeps the repo node in view on tall trees */
  viewport?: Viewport;
  /** Rows to animate after a live update (see useRowChanges). */
  changes?: RowChanges;
  repoName: string;
  selection: Selection;
  onSelect: (s: Selection, opts?: SelectOptions) => void;
  /** Enter on a node. Return true when handled (e.g. opened a PR) to skip selecting. */
  onEnter?: (s: Selection) => boolean;
  onToggleSubtree?: (name: string) => void;
  onToggleMerged?: (parent: string) => void;
  onToggleRun?: (name: string) => void;
  /** overrides layout.width (the caller keeps it from shrinking while scrolling) */
  width?: number;
}) {
  const vertical = direction === 'vertical';
  const { rows } = layout;
  const { start, end } = range ?? { start: 0, end: rows.length };
  const shown = rows.slice(start, end);
  const W = vertical ? colX(rows.length - 1) + V.COL / 2 + V.LEFT : (width ?? layout.width);
  const H = vertical ? verticalHeight(layout.maxItems) : layout.height;
  // Vertical: the repo node sits over the middle of the window, between the first and last column.
  const rx = vertical
    ? Math.min(
        Math.max(viewport ? viewport.top + viewport.height / 2 : colX(0), colX(0)),
        colX(rows.length - 1),
      )
    : 82;
  // The repo node sits at the middle of all rows (prototype); on a tall tree it is kept in the window.
  const ry = viewport
    ? Math.min(
        Math.max(layout.repoY, viewport.top + 40),
        Math.max(viewport.top + 40, viewport.top + viewport.height - 40),
      )
    : layout.repoY;

  const isSel = (s: Selection) => {
    switch (s.type) {
      case 'repo':
        return selection.type === 'repo';
      case 'branch':
        return (
          (selection.type === 'branch' && selection.name === s.name) ||
          (selection.type === 'compare' && (selection.a === s.name || selection.b === s.name))
        );
      case 'commit':
        return selection.type === 'commit' && selection.sha === s.sha;
      default:
        return false;
    }
  };

  const nodeProps = (s: Selection, label: string, press?: () => void) => ({
    className: 'bt-node',
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    'aria-pressed': press ? undefined : isSel(s),
    onClick: (e: MouseEvent) =>
      press ? press() : onSelect(s, { compare: e.shiftKey || e.metaKey || e.ctrlKey }),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (press) press();
        else if (e.shiftKey) onSelect(s, { compare: true });
        else if (!onEnter?.(s)) onSelect(s);
      } else if (e.key === ' ') {
        e.preventDefault();
        if (press) press();
        else onSelect(s, { compare: e.shiftKey });
      }
    },
  });

  const rowClass = (name: string) =>
    changes.leaving.has(name) ? 'bt-leave' : changes.entering.has(name) ? 'bt-enter' : undefined;

  const repoSel = selection.type === 'repo';
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="group"
      aria-label="Repository tree: repo, branches and commits"
      style={{ fontFamily: 'inherit' }}
    >
      <style>{FOCUS_CSS}</style>
      {shown.map((r, k) => (
        <path
          key={`edge-${r.kind === 'branch' ? r.branch.name : `merged:${r.parent}`}`}
          d={
            vertical
              ? `M${rx} 70 C${rx} 92,${colX(start + k)} 88,${colX(start + k)} ${V.BY}`
              : `M150 ${ry} C175 ${ry},170 ${r.y},${G.BX} ${r.y}`
          }
          fill="none"
          stroke="var(--t-line)"
          strokeWidth={1.2}
          strokeDasharray={r.kind === 'merged' ? '4 3' : undefined}
          className={r.kind === 'branch' ? rowClass(r.branch.name) : undefined}
        />
      ))}

      <g {...nodeProps({ type: 'repo' }, `Repository ${repoName}, ${layout.branchCount} branches`)}>
        <rect
          className="bt-shape"
          x={vertical ? rx - 68 : 14}
          y={vertical ? 14 : ry - 28}
          width={136}
          height={56}
          rx={10}
          fill={repoSel ? 'var(--t-accent-bg)' : 'var(--card)'}
          stroke="var(--t-accent)"
          strokeWidth={repoSel ? 2 : 1.2}
        />
        <text style={TEXT} x={rx} y={vertical ? 36 : ry - 6} textAnchor="middle">
          {short(repoName, 16)}
        </text>
        <text style={SUB} x={rx} y={vertical ? 55 : ry + 13} textAnchor="middle">
          {layout.branchCount} branches
        </text>
      </g>

      {shown.map((r, k) =>
        r.kind === 'merged' ? (
          <g
            key={`merged:${r.parent}`}
            transform={vertical ? boxShift(colX(start + k), r.y) : undefined}
          >
            <MergedGroup row={r} onToggle={onToggleMerged} />
          </g>
        ) : (
          <BranchRowView
            key={`row-${r.branch.name}`}
            row={r}
            col={vertical ? colX(start + k) : null}
            isSel={isSel}
            nodeProps={nodeProps}
            rowClass={rowClass}
            changes={changes}
            onToggleSubtree={onToggleSubtree}
            onToggleRun={onToggleRun}
          />
        ),
      )}
    </svg>
  );
}

type NodeProps = (
  s: Selection,
  label: string,
  press?: () => void,
) => Record<string, unknown> & { className: string };

/** Folded merged branches under one parent: "▸ 12 merged branches". */
function MergedGroup({ row, onToggle }: { row: GroupRow; onToggle?: (parent: string) => void }) {
  const n = row.names.length;
  const label = `${n} merged branch${n === 1 ? '' : 'es'}`;
  const toggle = () => onToggle?.(row.parent);
  return (
    <g data-merged-group={row.parent}>
      <g
        className="bt-node"
        tabIndex={0}
        role="button"
        aria-expanded={row.expanded}
        aria-label={`${label} compared with ${row.parent}`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <rect
          className="bt-shape"
          x={G.BX}
          y={row.y - 17}
          width={G.BW}
          height={34}
          rx={8}
          fill="var(--t-chip)"
          stroke="var(--border)"
          strokeDasharray="4 3"
        />
        <text style={SUB} x={G.BX + 14} y={row.y + 4}>
          {row.expanded ? '▾' : '▸'} {label}
        </text>
      </g>
    </g>
  );
}

/** Moves a row's box, drawn at (G.BX, y), to the top of the column centred on `cx` (vertical tree). */
const boxShift = (cx: number, y: number) =>
  `translate(${cx - G.BW / 2 - G.BX} ${V.BY + V.BH / 2 - y})`;

/** Half the item's length along the row (or column): where a link line meets it. */
const half = (it: Item, vertical: boolean) =>
  it.kind === 'more' ? (vertical ? 11 : it.w / 2) : it.kind === 'commit' && it.isHead ? 15 : 13;

function BranchRowView({
  row,
  col,
  isSel,
  nodeProps,
  rowClass,
  changes,
  onToggleSubtree,
  onToggleRun,
}: {
  row: BranchRow;
  /** vertical tree: this branch's column centre (null: a horizontal row) */
  col: number | null;
  isSel: (s: Selection) => boolean;
  nodeProps: NodeProps;
  rowClass: (name: string) => string | undefined;
  changes: RowChanges;
  onToggleSubtree?: (name: string) => void;
  onToggleRun?: (name: string) => void;
}) {
  const { branch: b, y, items, note, sub } = row;
  const sel = isSel({ type: 'branch', name: b.name });
  const openPr = b.pr?.state === 'open' ? b.pr : null;
  const spoken = sub.replace('↑', 'ahead ').replace('↓', 'behind ');
  const label = `Branch ${b.name}, ${spoken}${note ? `, ${note.text}` : ''}${
    b.recorded ? ', parent recorded' : ''
  }${
    openPr ? `, PR #${openPr.number} CI ${b.ci}` : b.pr ? `, PR #${b.pr.number} ${b.pr.state}` : ''
  }`;
  const flash = changes.flash.has(b.name);
  const cls = [rowClass(b.name), flash && 'bt-flash'].filter(Boolean).join(' ');
  // Badge left of the CI dot; the name is cut shorter to make room.
  const badgeX = G.BX + G.BW - (openPr ? 24 : 10) - BADGE_W;
  const vertical = col !== null;
  const shift = vertical ? boxShift(col, y) : undefined;
  // Item centres: along the row at `it.x`, or down the column one STEP apart.
  const at = (it: Item, k: number) =>
    vertical ? { cx: col, cy: V.ITEM0 + k * V.STEP } : { cx: it.x, cy: y };
  return (
    <g
      data-branch={b.name}
      className={cls || undefined}
      opacity={row.context ? 0.55 : undefined}
      data-context={row.context || undefined}
      data-flash={flash || undefined}
      data-entering={changes.entering.has(b.name) || undefined}
      data-leaving={changes.leaving.has(b.name) || undefined}
    >
      <g {...nodeProps({ type: 'branch', name: b.name }, label)} transform={shift}>
        <rect
          className="bt-shape"
          x={G.BX}
          y={y - 29}
          width={G.BW}
          height={58}
          rx={8}
          fill={sel ? 'var(--t-accent-bg)' : 'var(--card)'}
          stroke={sel ? 'var(--t-accent)' : 'var(--border)'}
          strokeWidth={sel ? 2 : 1}
        />
        <text style={TEXT} x={G.BX + 14} y={y - 11}>
          {short(b.name, b.recorded ? (openPr ? 16 : 18) : 26)}
        </text>
        {b.recorded && (
          <g data-recorded>
            <rect
              x={badgeX}
              y={y - 23}
              width={BADGE_W}
              height={16}
              rx={8}
              fill="var(--t-accent-bg)"
              stroke="var(--t-accent)"
              strokeWidth={0.8}
            />
            <text
              style={{ fontSize: 10.5, fontWeight: 600, fill: 'var(--t-accent)' }}
              x={badgeX + BADGE_W / 2}
              y={y - 11.5}
              textAnchor="middle"
            >
              recorded
            </text>
            <title>{RECORDED_TIP}</title>
          </g>
        )}
        <text style={SUB} x={G.BX + 14} y={y + 5}>
          {sub}
        </text>
        {note && (
          <text
            style={{ fontSize: 11.5, fill: NOTE_COLOR[note.tone] }}
            x={G.BX + 14}
            y={y + 20}
            data-note={note.tone}
          >
            {note.text}
          </text>
        )}
        {openPr && (
          <circle cx={G.BX + G.BW - 14} cy={y - 15} r={5} fill={CI_COLOR[b.ci]} data-ci={b.ci}>
            <title>{`PR #${openPr.number} CI: ${b.ci}`}</title>
          </circle>
        )}
      </g>

      {row.children > 0 && (
        <g
          {...nodeProps(
            { type: 'branch', name: b.name },
            `${row.collapsed ? 'Expand' : 'Collapse'} the ${row.children} branch${
              row.children === 1 ? '' : 'es'
            } compared with ${b.name}`,
            () => onToggleSubtree?.(b.name),
          )}
          aria-expanded={!row.collapsed}
          data-subtree-toggle={b.name}
          transform={shift}
        >
          <rect
            className="bt-shape"
            x={G.BX + G.BW - 40}
            y={y + 8}
            width={32}
            height={16}
            rx={8}
            fill="var(--t-chip)"
            stroke="var(--border)"
          />
          <text
            style={{ ...SUB, fontSize: 10.5 }}
            x={G.BX + G.BW - 24}
            y={y + 19.5}
            textAnchor="middle"
          >
            {row.collapsed ? '▸' : '▾'} {row.children}
          </text>
        </g>
      )}

      {items.length > 0 &&
        (vertical ? (
          <line
            x1={col}
            y1={V.BY + V.BH}
            x2={col}
            y2={at(items[0]!, 0).cy - half(items[0]!, true)}
            stroke="var(--t-line)"
            strokeWidth={1.2}
          />
        ) : (
          <line
            x1={G.BX + G.BW}
            y1={y}
            x2={leftEdge(items[0]!)}
            y2={y}
            stroke="var(--t-line)"
            strokeWidth={1.2}
          />
        ))}
      {items.map((it, k) => {
        const prev = k > 0 ? items[k - 1]! : null;
        const { cx, cy } = at(it, k);
        const link = !prev ? null : vertical ? (
          <line
            x1={col}
            y1={at(prev, k - 1).cy + half(prev, true)}
            x2={col}
            y2={cy - half(it, true)}
            stroke="var(--t-line)"
            strokeWidth={1.2}
          />
        ) : (
          <line
            x1={rightEdge(prev)}
            y1={y}
            x2={leftEdge(it)}
            y2={y}
            stroke="var(--t-line)"
            strokeWidth={1.2}
          />
        );
        if (it.kind === 'more') {
          const text = moreLabel(it);
          const toggle = it.expandable ? () => onToggleRun?.(b.name) : undefined;
          const aria = it.expanded
            ? `Hide older commits on ${b.name}${it.count > 0 ? ` (${it.count} more not drawn)` : ''}`
            : it.expandable
              ? `Show ${it.count} older commits on ${b.name}`
              : `${it.count} older commits on ${b.name}`;
          return (
            <g key="more">
              {link}
              <g
                {...nodeProps({ type: 'branch', name: b.name }, aria, toggle)}
                className={it.expandable ? 'bt-node bt-run' : 'bt-node'}
                aria-expanded={it.expandable ? it.expanded : undefined}
                data-run={it.expanded ? 'expanded' : 'collapsed'}
              >
                <rect
                  className="bt-shape"
                  x={cx - it.w / 2}
                  y={cy - 11}
                  width={it.w}
                  height={22}
                  rx={11}
                  fill="var(--t-chip)"
                  stroke="var(--border)"
                />
                <text style={SUB} x={cx} y={cy + 4} textAnchor="middle">
                  {text}
                </text>
                {it.expanded && it.count > 0 && (
                  <title>{`${it.count} older commits not drawn`}</title>
                )}
              </g>
            </g>
          );
        }
        const cs = isSel({ type: 'commit', sha: it.sha });
        const sw = cs ? 3.5 : 2;
        const kind = it.isSquash ? 'squash commit' : it.isMerge ? 'merge commit' : '';
        return (
          <g key={it.sha}>
            {link}
            <g
              {...nodeProps(
                { type: 'commit', sha: it.sha },
                `Commit ${shortSha(it.sha)}${kind ? `, ${kind}` : ''}${it.isHead ? `, head of ${b.name}` : ''}`,
              )}
              data-shape={it.isSquash ? 'squash' : it.isMerge ? 'merge' : 'commit'}
              data-head={it.isHead || undefined}
            >
              {it.isHead && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={15}
                  fill="none"
                  stroke="var(--t-accent)"
                  strokeWidth={1}
                />
              )}
              {it.isSquash ? (
                <rect
                  className="bt-shape"
                  x={cx - 10}
                  y={cy - 10}
                  width={20}
                  height={20}
                  rx={4}
                  fill="var(--card)"
                  stroke="var(--t-accent)"
                  strokeWidth={sw}
                />
              ) : (
                <circle
                  className="bt-shape"
                  cx={cx}
                  cy={cy}
                  r={10}
                  fill={it.isMerge ? 'var(--t-accent)' : 'var(--card)'}
                  stroke="var(--t-accent)"
                  strokeWidth={sw}
                />
              )}
              <text
                style={MONO}
                x={vertical ? cx + 22 : cx}
                y={vertical ? cy + 4 : cy + 30}
                textAnchor={vertical ? 'start' : 'middle'}
              >
                {shortSha(it.sha)}
              </text>
              <title>{`${it.sha}${kind ? ` · ${kind}` : ''}`}</title>
            </g>
          </g>
        );
      })}
    </g>
  );
}

const leftEdge = (it: Item) => (it.kind === 'more' ? it.x - it.w / 2 : it.x - 14);
const rightEdge = (it: Item) => (it.kind === 'more' ? it.x + it.w / 2 : it.x + 13);

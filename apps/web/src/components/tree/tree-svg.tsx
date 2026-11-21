'use client';

import type { CiState } from '@app/shared/client';
import type { KeyboardEvent } from 'react';
import { G, short, shortSha, type TreeLayout } from './layout';
import { NO_CHANGES, type RowChanges } from './use-row-changes';

export type Selection =
  { type: 'repo' } | { type: 'branch'; name: string } | { type: 'commit'; sha: string };

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

export function TreeSvg({
  layout,
  repoName,
  selection,
  onSelect,
  onEnter,
  changes = NO_CHANGES,
}: {
  layout: TreeLayout;
  /** Rows to animate after a live update (see useRowChanges). */
  changes?: RowChanges;
  repoName: string;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Enter on a node. Return true when handled (e.g. opened a PR) to skip selecting. */
  onEnter?: (s: Selection) => boolean;
}) {
  const { width: W, height: H, repoY: ry, rows } = layout;
  const isSel = (s: Selection) =>
    selection.type === s.type &&
    (s.type === 'repo' ||
      (s.type === 'branch' && selection.type === 'branch' && selection.name === s.name) ||
      (s.type === 'commit' && selection.type === 'commit' && selection.sha === s.sha));

  const nodeProps = (s: Selection, label: string) => ({
    className: 'bt-node',
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    'aria-pressed': isSel(s),
    onClick: () => onSelect(s),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!onEnter?.(s)) onSelect(s);
      } else if (e.key === ' ') {
        e.preventDefault();
        onSelect(s);
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
      {rows.map(({ branch, y }) => (
        <path
          key={`edge-${branch.name}`}
          d={`M150 ${ry} C175 ${ry},170 ${y},${G.BX} ${y}`}
          fill="none"
          stroke="var(--t-line)"
          strokeWidth={1.2}
          className={rowClass(branch.name)}
        />
      ))}

      <g {...nodeProps({ type: 'repo' }, `Repository ${repoName}, ${rows.length} branches`)}>
        <rect
          className="bt-shape"
          x={14}
          y={ry - 28}
          width={136}
          height={56}
          rx={10}
          fill={repoSel ? 'var(--t-accent-bg)' : 'var(--card)'}
          stroke="var(--t-accent)"
          strokeWidth={repoSel ? 2 : 1.2}
        />
        <text style={TEXT} x={82} y={ry - 6} textAnchor="middle">
          {short(repoName, 16)}
        </text>
        <text style={SUB} x={82} y={ry + 13} textAnchor="middle">
          {rows.length} branches
        </text>
      </g>

      {rows.map(({ branch: b, y, items, note, sub }) => {
        const sel = isSel({ type: 'branch', name: b.name });
        const openPr = b.pr?.state === 'open' ? b.pr : null;
        const spoken = sub.replace('↑', 'ahead ').replace('↓', 'behind ');
        const label = `Branch ${b.name}, ${spoken}${note ? `, ${note.text}` : ''}${
          b.recorded ? ', parent recorded' : ''
        }${
          openPr
            ? `, PR #${openPr.number} CI ${b.ci}`
            : b.pr
              ? `, PR #${b.pr.number} ${b.pr.state}`
              : ''
        }`;
        const flash = changes.flash.has(b.name);
        const cls = [rowClass(b.name), flash && 'bt-flash'].filter(Boolean).join(' ');
        // Badge left of the CI dot; the name is cut shorter to make room.
        const badgeX = G.BX + G.BW - (openPr ? 24 : 10) - BADGE_W;
        return (
          <g
            key={`row-${b.name}`}
            data-branch={b.name}
            className={cls || undefined}
            data-flash={flash || undefined}
            data-entering={changes.entering.has(b.name) || undefined}
            data-leaving={changes.leaving.has(b.name) || undefined}
          >
            <g {...nodeProps({ type: 'branch', name: b.name }, label)}>
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
                <circle
                  cx={G.BX + G.BW - 14}
                  cy={y - 15}
                  r={5}
                  fill={CI_COLOR[b.ci]}
                  data-ci={b.ci}
                >
                  <title>{`PR #${openPr.number} CI: ${b.ci}`}</title>
                </circle>
              )}
            </g>

            {items.length > 0 && (
              <line
                x1={G.BX + G.BW}
                y1={y}
                x2={items[0]!.x - 14}
                y2={y}
                stroke="var(--t-line)"
                strokeWidth={1.2}
              />
            )}
            {items.map((it, k) => {
              const link =
                k > 0 ? (
                  <line
                    x1={it.x - G.STEP + 13}
                    y1={y}
                    x2={it.x - 13}
                    y2={y}
                    stroke="var(--t-line)"
                    strokeWidth={1.2}
                  />
                ) : null;
              if (it.kind === 'more') {
                return (
                  <g key="more">
                    {link}
                    <g
                      {...nodeProps(
                        { type: 'branch', name: b.name },
                        `${it.count} older commits on ${b.name}`,
                      )}
                    >
                      <rect
                        className="bt-shape"
                        x={it.x - 18}
                        y={y - 11}
                        width={36}
                        height={22}
                        rx={11}
                        fill="var(--t-chip)"
                        stroke="var(--border)"
                      />
                      <text style={SUB} x={it.x} y={y + 4} textAnchor="middle">
                        +{it.count}
                      </text>
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
                        cx={it.x}
                        cy={y}
                        r={15}
                        fill="none"
                        stroke="var(--t-accent)"
                        strokeWidth={1}
                      />
                    )}
                    {it.isSquash ? (
                      <rect
                        className="bt-shape"
                        x={it.x - 10}
                        y={y - 10}
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
                        cx={it.x}
                        cy={y}
                        r={10}
                        fill={it.isMerge ? 'var(--t-accent)' : 'var(--card)'}
                        stroke="var(--t-accent)"
                        strokeWidth={sw}
                      />
                    )}
                    <text style={MONO} x={it.x} y={y + 30} textAnchor="middle">
                      {shortSha(it.sha)}
                    </text>
                    <title>{`${it.sha}${kind ? ` · ${kind}` : ''}`}</title>
                  </g>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

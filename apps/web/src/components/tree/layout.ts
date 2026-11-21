// Pure layout for the Branches tab. Ported from docs/branch-tree/prototype.html (`reach`,
// `ownCommits`, `branchOrder`, `mergeNote`, `whyShort`, `whyLong`, `renderTree` geometry).
// Works only on what the snapshot carries: SHAs, parents, commit times, refs, PR numbers, CI.
import type { BranchNode, PullRequestState, TreeSnapshot } from '@app/shared/client';
import { isComputed } from './scale-contract';
import type { ViewRow } from './view';

export const MAX_SHOWN = 7;
export const METHOD = { merge: 'merge commit', squash: 'squash', rebase: 'rebase' } as const;

// Geometry from the prototype's renderTree().
export const G = {
  RH: 78,
  TOP: 32,
  BX: 196,
  BW: 236,
  STEP: 64,
  get CX() {
    return this.BX + this.BW + 48;
  },
} as const;

export const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const shortSha = (sha: string) => sha.slice(0, 7);

/** `reach` sets kept per graph: enough for a screen of rows and their compare-with targets. */
const REACH_CACHE_MAX = 128;

/** Commit index over the snapshot's commits (parents outside the snapshot are ignored). */
export class TreeGraph {
  private readonly byId = new Map<string, TreeSnapshot['commits'][number]>();
  private readonly order = new Map<string, number>();
  // Bounded: with 500 branches over 20k commits, one set per branch would hold millions of entries.
  private readonly reachCache = new Map<string, Set<string>>();
  private childIndex: Map<string, string[]> | null = null;

  constructor(commits: TreeSnapshot['commits']) {
    commits.forEach((c, i) => {
      if (this.byId.has(c.sha)) return;
      this.byId.set(c.sha, c);
      this.order.set(c.sha, i);
    });
  }

  get size() {
    return this.byId.size;
  }

  commit(sha: string) {
    return this.byId.get(sha);
  }

  /** Every drawn commit reachable from `sha` (inclusive). Iterative: deep histories are fine. */
  reach(sha: string): Set<string> {
    const cached = this.reachCache.get(sha);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      const c = this.byId.get(x);
      if (!c) continue;
      seen.add(x);
      for (const p of c.parents) stack.push(p);
    }
    this.reachCache.set(sha, seen);
    if (this.reachCache.size > REACH_CACHE_MAX)
      this.reachCache.delete(this.reachCache.keys().next().value!);
    return seen;
  }

  /** Every drawn commit that has `sha` in its history (inclusive). */
  descendants(sha: string): Set<string> {
    if (!this.childIndex) {
      this.childIndex = new Map();
      for (const c of this.byId.values())
        for (const p of c.parents) {
          const list = this.childIndex.get(p);
          if (list) list.push(c.sha);
          else this.childIndex.set(p, [c.sha]);
        }
    }
    const seen = new Set<string>();
    const stack = this.byId.has(sha) ? [sha] : [];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const k of this.childIndex.get(x) ?? []) stack.push(k);
    }
    return seen;
  }

  /** Oldest first: commit time, then snapshot order. */
  sort(shas: Iterable<string>): string[] {
    const t = (s: string) => Date.parse(this.byId.get(s)?.committedAt ?? '') || 0;
    return [...shas].sort((a, b) => t(a) - t(b) || this.order.get(a)! - this.order.get(b)!);
  }
}

/** Prototype `branchOrder`: default branch, then a depth-first walk of compare-with children by name. */
export function branchOrder(snapshot: TreeSnapshot): BranchNode[] {
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const children = new Map<string, string[]>();
  for (const b of snapshot.branches) {
    if (!b.compareWith || b.isDefault) continue;
    children.set(b.compareWith, [...(children.get(b.compareWith) ?? []), b.name]);
  }
  for (const list of children.values()) list.sort();
  const out: BranchNode[] = [];
  const seen = new Set<string>();
  const stack = byName.has(snapshot.defaultBranch) ? [snapshot.defaultBranch] : [];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(byName.get(name)!);
    const kids = children.get(name) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  for (const b of snapshot.branches) if (!seen.has(b.name)) out.push(b);
  return out;
}

/** Depth in the compare-with chain (default = 0), for the accessible label and tests. */
export function depthOf(snapshot: TreeSnapshot, name: string): number {
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  let depth = 0;
  const seen = new Set<string>();
  let cur = byName.get(name);
  while (cur && cur.compareWith && !seen.has(cur.name)) {
    seen.add(cur.name);
    depth++;
    cur = byName.get(cur.compareWith);
  }
  return depth;
}

/**
 * Prototype `ownCommits`: the default branch's whole drawn history, else the commits ahead of its
 * compare-with branch. `total` uses the server's `ahead` count, so older commits outside the
 * snapshot still show up in the `+N` chip.
 */
export function ownCommits(
  graph: TreeGraph,
  branch: BranchNode,
  byName: Map<string, BranchNode>,
): { shas: string[]; total: number } {
  const mine = graph.reach(branch.headSha);
  const base = branch.compareWith ? byName.get(branch.compareWith) : undefined;
  if (!base) {
    const shas = graph.sort(mine);
    return { shas, total: shas.length };
  }
  const theirs = graph.reach(base.headSha);
  const shas = graph.sort([...mine].filter((x) => !theirs.has(x)));
  return { shas, total: Math.max(shas.length, branch.ahead) };
}

export function whyShort(b: Pick<BranchNode, 'why' | 'whyPr' | 'ambiguous'>): string {
  switch (b.why) {
    case 'override':
      return 'set by hand';
    case 'pr':
      return `PR #${b.whyPr}`;
    case 'recorded':
      return b.ambiguous ? 'ambiguous' : 'recorded';
    case 'inferred':
      return 'guess';
    default:
      return 'default';
  }
}

/** `canEdit`: the "Compare with" select is shown below, as in the prototype ("Set by hand below."). */
export function whyLong(b: BranchNode, canEdit = false): string {
  switch (b.why) {
    case 'override':
      return canEdit ? 'Set by hand below.' : 'Set by hand.';
    case 'pr': {
      const state: PullRequestState | undefined =
        b.pr && b.pr.number === b.whyPr ? b.pr.state : undefined;
      return `Target of PR #${b.whyPr}${state ? ` (${state})` : ''}.`;
    }
    case 'recorded':
      return b.ambiguous
        ? `Recorded when the branch appeared, but ${b.ambiguous} branches were at that commit, so this is the closest of them.`
        : 'Recorded when the branch appeared: it was the only branch at that commit.';
    case 'inferred':
      return 'Guessed from the commit graph: the long-lived branch, or a branch this one fully contains, that it is fewest commits beyond.';
    default:
      return b.loop
        ? 'The choices formed a loop, so the default branch.'
        : 'Nothing better known, so the default branch.';
  }
}

export type Note = { text: string; tone: 'ok' | 'warn' | 'muted' };

/**
 * The third line of a branch box (prototype `mergeNote`): the merged state first, else "same commit
 * as X" when the branch head is its compare-with branch's head.
 */
export function mergeNote(b: BranchNode, byName: Map<string, BranchNode>): Note | null {
  const m = b.merged;
  if (m?.via === 'pr') {
    if (m.newCommits > 0) return { text: `${m.newCommits} new since #${m.prNumber}`, tone: 'warn' };
    return {
      text: `merged via #${m.prNumber}${m.method ? ` (${METHOD[m.method]})` : ''}`,
      tone: 'ok',
    };
  }
  if (m) return { text: `content in ${short(m.into, 12)} (${m.via})`, tone: 'ok' };
  const base = b.compareWith ? byName.get(b.compareWith) : undefined;
  if (base && base.headSha === b.headSha)
    return { text: `same commit as ${short(base.name, 16)}`, tone: 'muted' };
  return null;
}

/** "↑a ↓b vs X · why", or "default branch". Counts the server has not computed yet show as "…". */
export function subLine(b: BranchNode): string {
  if (!b.compareWith) return 'default branch';
  const [a, z] = isComputed(b) ? [b.ahead, b.behind] : ['…', '…'];
  return `↑${a} ↓${z} vs ${short(b.compareWith, 14)} · ${whyShort(b)}`;
}

export function mergedLong(b: BranchNode): string {
  const m = b.merged;
  if (!m) return 'No';
  if (m.via === 'pr') {
    const how = m.method ? ` (${METHOD[m.method]})` : '';
    return m.newCommits > 0
      ? `Was merged via PR #${m.prNumber}${how}; ${m.newCommits} new commit${m.newCommits === 1 ? '' : 's'} since.`
      : `Yes, via PR #${m.prNumber}${how}.`;
  }
  return `Its changes are already in ${m.into} (${m.via}), with no PR on record.`;
}

export type Item =
  | {
      kind: 'more';
      /** older commits hidden behind the chip (collapsed), or not drawn at all (expanded) */
      count: number;
      x: number;
      /** chip width */
      w: number;
      /** the run is expanded: every drawn commit is shown and the chip folds them again */
      expanded: boolean;
      /** more commits are drawn than shown, so a click expands the run (else it selects the branch) */
      expandable: boolean;
    }
  | {
      kind: 'commit';
      sha: string;
      x: number;
      isHead: boolean;
      isMerge: boolean;
      isSquash: boolean;
    };

export type BranchRow = {
  kind: 'branch';
  branch: BranchNode;
  y: number;
  /** empty for rows outside the rendered range (computed lazily) */
  items: Item[];
  note: Note | null;
  sub: string;
  depth: number;
  children: number;
  collapsed: boolean;
  context: boolean;
};
export type GroupRow = {
  kind: 'merged';
  parent: string;
  names: string[];
  expanded: boolean;
  y: number;
  depth: number;
};
export type Row = BranchRow | GroupRow;

export type TreeLayout = {
  width: number;
  height: number;
  repoY: number;
  rows: Row[];
  /** every branch in the snapshot (the repo node's label), not only the rows shown */
  branchCount: number;
};

/** Row index range [start, end) whose commits are laid out and drawn. */
export type RowRange = { start: number; end: number };

/** Chip text: "… 120 commits" folded, "hide" when the run is expanded. */
export const moreLabel = (it: { count: number; expanded: boolean }) =>
  it.expanded ? 'hide' : `… ${it.count} commit${it.count === 1 ? '' : 's'}`;
/** Approximate chip width for its label (12px text). */
export const chipWidth = (label: string) => Math.max(36, Math.round(label.length * 6.8 + 18));

export const rowY = (i: number) => G.TOP + 26 + i * G.RH;

/** Width of a row with a wide "… N commits" chip and MAX_SHOWN commits (see `layoutTree`). */
export const fullRowWidth = () =>
  G.CX -
  18 +
  chipWidth(moreLabel({ count: 99_999, expanded: false })) +
  G.STEP -
  18 +
  (MAX_SHOWN - 1) * G.STEP +
  G.STEP +
  20;

/** Squash commits to draw as squares: `merged.mergeCommitSha` of branches merged by squash. */
export function squashShas(snapshot: TreeSnapshot): Set<string> {
  const out = new Set<string>();
  for (const b of snapshot.branches)
    if (b.merged?.method === 'squash' && b.merged.mergeCommitSha) out.add(b.merged.mergeCommitSha);
  return out;
}

export type LayoutOptions = {
  /** rows to show (see `viewRows`); default: every branch in prototype order */
  rows?: readonly ViewRow[];
  /** branches whose linear run of older commits is expanded */
  expanded?: ReadonlySet<string>;
  /** only these rows get their commits laid out (virtualized list); default: all */
  range?: RowRange;
};

/** Commits of one row: oldest → newest, head on the right; older ones fold into a chip. */
export function rowItems(
  graph: TreeGraph,
  branch: BranchNode,
  byName: Map<string, BranchNode>,
  squash: ReadonlySet<string>,
  expanded: boolean,
): Item[] {
  const { shas, total } = ownCommits(graph, branch, byName);
  const shown = expanded ? shas : shas.slice(-MAX_SHOWN);
  const hidden = total - shown.length;
  const items: Item[] = [];
  let x = G.CX;
  if (hidden > 0 || (expanded && shas.length > MAX_SHOWN)) {
    const expandable = shas.length > MAX_SHOWN;
    const it = { count: hidden, expanded: expanded && expandable, expandable };
    const w = chipWidth(moreLabel(it));
    // Left edge where the prototype's 36px chip starts; the first commit keeps one STEP of gap.
    const cx = x - 18 + w / 2;
    items.push({ kind: 'more', ...it, x: cx, w });
    x = cx + w / 2 + G.STEP - 18;
  }
  for (const sha of shown) {
    const c = graph.commit(sha)!;
    items.push({
      kind: 'commit',
      sha,
      x,
      isHead: sha === branch.headSha,
      isMerge: c.parents.length > 1,
      isSquash: squash.has(sha),
    });
    x += G.STEP;
  }
  return items;
}

const allRows = (snapshot: TreeSnapshot): ViewRow[] =>
  branchOrder(snapshot).map((branch) => ({
    kind: 'branch',
    branch,
    depth: depthOf(snapshot, branch.name),
    children: 0,
    collapsed: false,
    context: false,
  }));

/** Centre of a row's last item (a chip counts by its right edge). */
const rowRight = (items: Item[]) => {
  const last = items.at(-1);
  return last ? last.x + (last.kind === 'more' ? last.w / 2 : 0) : G.CX;
};

/** Prototype `renderTree` geometry. `squashShas`: commits to draw as squares (see `squashShas`). */
export function layoutTree(
  snapshot: TreeSnapshot,
  graph: TreeGraph,
  squashShas: ReadonlySet<string> = new Set(),
  opts: LayoutOptions = {},
): TreeLayout {
  const view = opts.rows ?? allRows(snapshot);
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const range = opts.range ?? { start: 0, end: view.length };
  let right = G.CX;

  const rows: Row[] = view.map((r, i): Row => {
    const y = rowY(i);
    if (r.kind === 'merged') return { ...r, y };
    const inRange = i >= range.start && i < range.end;
    const items = inRange
      ? rowItems(graph, r.branch, byName, squashShas, opts.expanded?.has(r.branch.name) ?? false)
      : [];
    right = Math.max(right, rowRight(items));
    return {
      ...r,
      y,
      items,
      note: mergeNote(r.branch, byName),
      sub: subLine(r.branch),
    };
  });

  const last = Math.max(0, rows.length - 1);
  return {
    // Prototype: CX - 10 + maxItems * STEP + 30, i.e. the last item's centre + STEP + 20.
    width: Math.max(760, right + G.STEP + 20),
    height: rowY(last) + 54,
    repoY: (rowY(0) + rowY(last)) / 2,
    rows,
    branchCount: snapshot.branches.length,
  };
}

/** Branches whose drawn history contains `sha` (one walk down from `sha`, not one per branch). */
export function branchesContaining(snapshot: TreeSnapshot, graph: TreeGraph, sha: string) {
  const below = graph.descendants(sha);
  return snapshot.branches.filter((b) => below.has(b.headSha)).map((b) => b.name);
}

// Which rows the Branches tab shows (T6b): search, filters, collapsed subtrees and folded merged
// branches. Pure. Row order is the prototype's `branchOrder` (default branch, then a depth-first walk
// of compare-with children by name); collapsing only hides rows, it never reorders them.
import type { BranchNode, TreeSnapshot } from '@app/shared/client';

export const TREE_FILTERS = ['mine', 'open-pr', 'ci-failing', 'merged', 'stale'] as const;
export type TreeFilter = (typeof TREE_FILTERS)[number];

export const FILTER_LABEL: Record<TreeFilter, string> = {
  mine: 'Mine',
  'open-pr': 'With open PR',
  'ci-failing': 'CI failing',
  merged: 'Merged',
  stale: 'Stale',
};

export const STALE_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_Q = 255;

/** `?q=&f=`: name search and filters (comma separated). All filters must match (AND). */
export type TreeView = { q: string; f: TreeFilter[] };
export const EMPTY_VIEW: TreeView = { q: '', f: [] };

export const isFiltering = (v: TreeView) => v.q.trim() !== '' || v.f.length > 0;

export function parseView(search: string): TreeView {
  const p = new URLSearchParams(search);
  const q = (p.get('q') ?? '').slice(0, MAX_Q);
  const want = new Set((p.get('f') ?? '').split(','));
  return { q, f: TREE_FILTERS.filter((f) => want.has(f)) };
}

/** `search` with q/f replaced (empty ones dropped); other params are kept. Returns '' or '?…'. */
export function viewSearch(view: TreeView, search = ''): string {
  const p = new URLSearchParams(search);
  p.delete('q');
  p.delete('f');
  if (view.q.trim()) p.set('q', view.q);
  if (view.f.length) p.set('f', TREE_FILTERS.filter((f) => view.f.includes(f)).join(','));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export type MatchContext = {
  /** PR numbers the viewer opened (GET /tree `x-tree-mine-prs`). */
  minePrs: ReadonlySet<number>;
  /** Commit time (ms) of a head SHA, or null when the snapshot does not carry that commit. */
  headTime: (sha: string) => number | null;
  now: number;
};

export function matchesFilter(b: BranchNode, f: TreeFilter, ctx: MatchContext): boolean {
  switch (f) {
    case 'mine':
      return b.pr !== null && ctx.minePrs.has(b.pr.number);
    case 'open-pr':
      return b.pr?.state === 'open';
    case 'ci-failing':
      return b.ci === 'failure';
    case 'merged':
      return b.merged !== null;
    case 'stale': {
      // VERIFY: head commit time comes from the drawn commits; a head the snapshot did not draw
      // counts as not stale (see CONTRACT_REQUESTS "[Task T6b] headCommittedAt").
      const t = ctx.headTime(b.headSha);
      return t !== null && ctx.now - t > STALE_DAYS * DAY_MS;
    }
  }
}

export function matches(b: BranchNode, view: TreeView, ctx: MatchContext): boolean {
  const q = view.q.trim().toLowerCase();
  if (q && !b.name.toLowerCase().includes(q)) return false;
  return view.f.every((f) => matchesFilter(b, f, ctx));
}

export type ViewRow =
  | {
      kind: 'branch';
      branch: BranchNode;
      depth: number;
      /** direct compare-with children */
      children: number;
      collapsed: boolean;
      /** shown only as the ancestor of a match (filtering) */
      context: boolean;
    }
  | {
      kind: 'merged';
      /** the branch these merged branches are compared with */
      parent: string;
      names: string[];
      expanded: boolean;
      depth: number;
    };

export type ViewState = {
  view: TreeView;
  ctx: MatchContext;
  /** branches whose compare-with subtree is folded */
  collapsed: ReadonlySet<string>;
  /** parents whose merged children are unfolded (merged branches are folded by default) */
  mergedOpen: ReadonlySet<string>;
};

/** Children by compare-with target, names sorted (prototype `branchOrder`). */
function childrenOf(snapshot: TreeSnapshot): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const b of snapshot.branches) {
    if (!b.compareWith || b.isDefault) continue;
    const list = children.get(b.compareWith);
    if (list) list.push(b.name);
    else children.set(b.compareWith, [b.name]);
  }
  for (const list of children.values()) list.sort();
  return children;
}

/** Branches whose whole compare-with subtree is merged: those fold away; active work never does. */
function foldable(snapshot: TreeSnapshot, children: Map<string, string[]>): Set<string> {
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  // Iterative post-order so deep stacks of branches cannot overflow; a loop counts as not foldable.
  for (const root of snapshot.branches) {
    const stack: [string, boolean][] = [[root.name, false]];
    while (stack.length) {
      const [name, done] = stack.pop()!;
      if (memo.has(name)) continue;
      const kids = children.get(name) ?? [];
      if (!done) {
        if (visiting.has(name)) {
          memo.set(name, false);
          continue;
        }
        visiting.add(name);
        stack.push([name, true]);
        for (const k of kids) if (!memo.has(k) && !visiting.has(k)) stack.push([k, false]);
        continue;
      }
      visiting.delete(name);
      const b = byName.get(name);
      memo.set(name, !!b && !b.isDefault && b.merged !== null && kids.every((k) => memo.get(k)));
    }
  }
  return new Set([...memo].filter(([, v]) => v).map(([k]) => k));
}

/**
 * The rows to draw, in prototype order. Not filtering: collapsed subtrees are hidden, and merged
 * branches (whose subtree is all merged) fold into one "N merged branches" row per parent. Filtering:
 * matches plus their compare-with ancestors (as context), nothing folded.
 */
export function viewRows(snapshot: TreeSnapshot, state: ViewState): ViewRow[] {
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const children = childrenOf(snapshot);
  const filtering = isFiltering(state.view);

  let include: Set<string> | null = null;
  let matched: Set<string> | null = null;
  if (filtering) {
    matched = new Set(
      snapshot.branches.filter((b) => matches(b, state.view, state.ctx)).map((b) => b.name),
    );
    include = new Set();
    for (const name of matched) {
      for (let b = byName.get(name); b && !include.has(b.name);) {
        include.add(b.name);
        b = b.compareWith ? byName.get(b.compareWith) : undefined;
      }
    }
  }
  const fold = filtering ? new Set<string>() : foldable(snapshot, children);

  const out: ViewRow[] = [];
  const seen = new Set<string>();
  type Frame =
    | { t: 'branch'; name: string; depth: number }
    | { t: 'group'; parent: string; names: string[]; depth: number };
  const visit = (rootName: string) => {
    const stack: Frame[] = [{ t: 'branch', name: rootName, depth: 0 }];
    while (stack.length) {
      const f = stack.pop()!;
      if (f.t === 'group') {
        const expanded = state.mergedOpen.has(f.parent);
        out.push({ kind: 'merged', parent: f.parent, names: f.names, expanded, depth: f.depth });
        if (expanded)
          for (let i = f.names.length - 1; i >= 0; i--)
            stack.push({ t: 'branch', name: f.names[i]!, depth: f.depth });
        else markSubtree(f.names, children, seen);
        continue;
      }
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      const branch = byName.get(f.name)!;
      const kids = (children.get(f.name) ?? []).filter((k) => !seen.has(k));
      const collapsed = !filtering && state.collapsed.has(f.name) && kids.length > 0;
      if (!include || include.has(f.name))
        out.push({
          kind: 'branch',
          branch,
          depth: f.depth,
          children: filtering ? 0 : kids.length,
          collapsed,
          context: matched !== null && !matched.has(f.name),
        });
      if (collapsed) {
        markSubtree(kids, children, seen);
        continue;
      }
      const shown = kids.filter((k) => !fold.has(k));
      const folded = kids.filter((k) => fold.has(k));
      if (folded.length)
        stack.push({ t: 'group', parent: f.name, names: folded, depth: f.depth + 1 });
      for (let i = shown.length - 1; i >= 0; i--)
        stack.push({ t: 'branch', name: shown[i]!, depth: f.depth + 1 });
    }
  };
  if (byName.has(snapshot.defaultBranch)) visit(snapshot.defaultBranch);
  // Branches the walk did not reach (no path to the default branch): appended, like the prototype.
  for (const b of snapshot.branches) if (!seen.has(b.name)) visit(b.name);
  return out;
}

/** Marks a folded subtree as seen so the "unreached" pass does not draw it. */
function markSubtree(roots: string[], children: Map<string, string[]>, seen: Set<string>) {
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(children.get(n) ?? []));
  }
}

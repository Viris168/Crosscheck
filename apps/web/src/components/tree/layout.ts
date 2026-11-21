// Pure layout for the Branches tab. Ported from docs/branch-tree/prototype.html (`reach`,
// `ownCommits`, `branchOrder`, `mergeNote`, `whyShort`, `whyLong`, `renderTree` geometry).
// Works only on what the snapshot carries: SHAs, parents, commit times, refs, PR numbers, CI.
import type { BranchNode, PullRequestState, TreeSnapshot } from '@app/shared/client';

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

/** Commit index over the snapshot's commits (parents outside the snapshot are ignored). */
export class TreeGraph {
  private readonly byId = new Map<string, TreeSnapshot['commits'][number]>();
  private readonly order = new Map<string, number>();
  private readonly reachCache = new Map<string, Set<string>>();

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

export function whyLong(b: BranchNode): string {
  switch (b.why) {
    case 'override':
      return 'Set by hand.';
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

/** "↑a ↓b vs X · why", or "default branch". */
export function subLine(b: BranchNode): string {
  if (!b.compareWith) return 'default branch';
  return `↑${b.ahead} ↓${b.behind} vs ${short(b.compareWith, 14)} · ${whyShort(b)}`;
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
  | { kind: 'more'; count: number; x: number }
  | {
      kind: 'commit';
      sha: string;
      x: number;
      isHead: boolean;
      isMerge: boolean;
      isSquash: boolean;
    };

export type Row = { branch: BranchNode; y: number; items: Item[]; note: Note | null; sub: string };

export type TreeLayout = {
  width: number;
  height: number;
  repoY: number;
  rows: Row[];
};

/**
 * Prototype `renderTree` geometry. `squashShas`: commits to draw as squares. The snapshot does not
 * mark squash commits yet (see tasks/CONTRACT_REQUESTS.md), so callers pass an empty set for now.
 */
export function layoutTree(
  snapshot: TreeSnapshot,
  graph: TreeGraph,
  squashShas: ReadonlySet<string> = new Set(),
): TreeLayout {
  const ordered = branchOrder(snapshot);
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const yOf = (i: number) => G.TOP + 26 + i * G.RH;
  let maxItems = 1;

  const rows: Row[] = ordered.map((branch, i) => {
    const { shas, total } = ownCommits(graph, branch, byName);
    const shown = shas.slice(-MAX_SHOWN);
    const more = total - shown.length;
    const items: Item[] = [];
    let x = G.CX;
    if (more > 0) {
      items.push({ kind: 'more', count: more, x });
      x += G.STEP;
    }
    for (const sha of shown) {
      const c = graph.commit(sha)!;
      items.push({
        kind: 'commit',
        sha,
        x,
        isHead: sha === branch.headSha,
        isMerge: c.parents.length > 1,
        isSquash: squashShas.has(sha),
      });
      x += G.STEP;
    }
    maxItems = Math.max(maxItems, items.length);
    return { branch, y: yOf(i), items, note: mergeNote(branch, byName), sub: subLine(branch) };
  });

  const last = Math.max(0, rows.length - 1);
  return {
    width: Math.max(760, G.CX - 10 + maxItems * G.STEP + 30),
    height: yOf(last) + 54,
    repoY: (yOf(0) + yOf(last)) / 2,
    rows,
  };
}

/** Branches whose drawn history contains `sha`. */
export function branchesContaining(snapshot: TreeSnapshot, graph: TreeGraph, sha: string) {
  return snapshot.branches.filter((b) => graph.reach(b.headSha).has(sha)).map((b) => b.name);
}

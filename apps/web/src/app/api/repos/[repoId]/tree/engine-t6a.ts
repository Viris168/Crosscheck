// MOCK of T6a's engine additions (tasks/T6a-engine-scale.md → "Do" 3 and 5), until T6a is merged.
// Same names and signatures as T6a, imported directly by the routes (no dynamic shim), so swapping the
// import to '@app/git-graph' is a one-line change and typecheck flags any signature drift.
// TODO(T6a): delete this file and import `compare` / `buildSnapshot` from '@app/git-graph'.
import {
  buildSnapshot as buildFullSnapshot,
  CommitGraph,
  type SnapshotInput,
} from '@app/git-graph';
import type { TreeSnapshot } from '@app/shared';

/**
 * `ahead`/`behind` of a branch whose counts were not computed (outside `visible` and its compare-with
 * chains). VERIFY: sentinel agreed with T6a ("coordinate the sentinel with T6b").
 */
export const NOT_COMPUTED = -1;

/** T6a "Do" 5: `compare(graph, a, b) → { ahead, behind, mergeBase }`. */
export interface CompareResult {
  ahead: number;
  behind: number;
  mergeBase: string | null;
}

/** T6a "Do" 3: `buildSnapshot({ visible: string[] })`. Omitted `visible` = every branch (today's behaviour). */
export type LazySnapshotInput = SnapshotInput & { visible?: readonly string[] };

/**
 * Commits `a` has that `b` lacks (ahead), the reverse (behind) and their best common ancestor.
 * VERIFY: `a`/`b` are commit SHAs (branch head SHAs); T6a may take branch names instead.
 */
export function compare(graph: CommitGraph, a: string, b: string): CompareResult {
  const { ahead, behind } = graph.aheadBehind(a, b);
  return { ahead, behind, mergeBase: graph.mergeBase(a, b) };
}

/** `visible` plus every branch on their compare-with chains (the rows they are measured against). */
function withChains(snapshot: TreeSnapshot, visible: readonly string[]): Set<string> {
  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  const keep = new Set<string>();
  for (const v of visible) {
    let cur = byName.get(v);
    while (cur && !keep.has(cur.name)) {
      keep.add(cur.name);
      cur = cur.compareWith ? byName.get(cur.compareWith) : undefined;
    }
  }
  return keep;
}

/**
 * Lazy table: compare-with for every branch (cheap), ahead/behind/merge-base only for `visible` and
 * their chains; others get NOT_COMPUTED. `commits` holds only what the kept rows draw.
 * The mock computes the full snapshot and blanks the rest: same output, none of T6a's speed.
 */
export function buildSnapshot(input: LazySnapshotInput): TreeSnapshot {
  const graph = input.graph instanceof CommitGraph ? input.graph : new CommitGraph(input.graph);
  const full = buildFullSnapshot({ ...input, graph });
  if (!input.visible) return full;

  const keep = withChains(full, input.visible);
  const byName = new Map(full.branches.map((b) => [b.name, b]));
  const cap = input.maxCommitsPerBranch ?? 50;
  const drawn = new Set<string>();
  for (const name of keep) {
    const b = byName.get(name)!;
    const target = b.compareWith ? byName.get(b.compareWith) : undefined;
    const own = target ? graph.aheadCommits(b.headSha, target.headSha) : graph.reachable(b.headSha);
    for (const sha of own.slice(-cap)) drawn.add(sha);
  }
  return {
    ...full,
    branches: full.branches.map((b) =>
      keep.has(b.name) ? b : { ...b, ahead: NOT_COMPUTED, behind: NOT_COMPUTED, mergeBase: null },
    ),
    commits: full.commits.filter((c) => drawn.has(c.sha)),
  };
}

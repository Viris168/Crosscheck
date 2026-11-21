// Compare-with overrides on top of the stored snapshot, without a sync (tasks/T4-compare-with.md, "Do" 2).
// Pure and in-memory: the snapshot's commit graph, the current `CompareOverride` rows and (only when an
// override was cleared) the PR records + recorded parents the automatic rules need.
//
// Branches whose override did not change keep the choice and the exact counts the sync job computed.
// Only branches whose compare-with target changes get ahead/behind/merge-base recomputed here, on the
// snapshot's drawn commits; the next sync replaces them with counts from the full clone.
import { CommitGraph, pickCompareWith, type CompareChoice, type PrRecord } from '@app/git-graph';
import type { BranchNode, TreeSnapshot } from '@app/shared';

export type Overrides = Readonly<Record<string, string>>;

/** What the automatic rules (PR target, recorded, guess) need. Loaded only when an override is cleared. */
export interface AutomaticInputs {
  prs: readonly PrRecord[];
  recordedParents: Readonly<Record<string, readonly string[]>>;
}

type Choice = CompareChoice;

const choiceOf = (b: BranchNode): Choice => ({
  compareWith: b.compareWith,
  why: b.why,
  whyPr: b.whyPr,
  ambiguous: b.ambiguous,
  loop: b.loop,
});

const manual = (compareWith: string): Choice => ({
  compareWith,
  why: 'override',
  whyPr: null,
  ambiguous: null,
  loop: false,
});

/** An override counts only when its target is in the tree, is another branch, and B is not the default. */
function liveOverride(snapshot: TreeSnapshot, names: Set<string>, b: string, overrides: Overrides) {
  const t = Object.hasOwn(overrides, b) ? overrides[b] : undefined;
  return t !== undefined && t !== b && names.has(t) && b !== snapshot.defaultBranch ? t : null;
}

/** Branches whose stored choice was an override that no longer applies: they need the automatic rules. */
export function clearedBranches(snapshot: TreeSnapshot, overrides: Overrides): string[] {
  const names = new Set(snapshot.branches.map((b) => b.name));
  return snapshot.branches
    .filter((b) => b.why === 'override' && !liveOverride(snapshot, names, b.name, overrides))
    .map((b) => b.name);
}

/** The commit graph the page draws, plus a parentless stub for any branch head that was not drawn. */
function graphOf(snapshot: TreeSnapshot): CommitGraph {
  const drawn = new Set(snapshot.commits.map((c) => c.sha));
  const stubs = snapshot.branches
    .filter((b) => !drawn.has(b.headSha))
    .map((b) => ({ sha: b.headSha, parents: [], committedAt: new Date(0).toISOString() }));
  return new CommitGraph([...snapshot.commits, ...stubs]);
}

/** Every branch's choice before loops are broken. */
function rawChoices(
  snapshot: TreeSnapshot,
  overrides: Overrides,
  auto: AutomaticInputs | null,
  graph: () => CommitGraph,
): Map<string, Choice> {
  const names = new Set(snapshot.branches.map((b) => b.name));
  let automatic: Map<string, Choice> | null = null;
  const m = new Map<string, Choice>();
  for (const b of snapshot.branches) {
    const o = liveOverride(snapshot, names, b.name, overrides);
    if (o) {
      m.set(b.name, manual(o));
    } else if (b.why === 'override') {
      automatic ??= pickCompareWith({
        graph: graph(),
        defaultBranch: snapshot.defaultBranch,
        branches: snapshot.branches.map((x) => ({
          name: x.name,
          headSha: x.headSha,
          recordedParents: auto?.recordedParents[x.name] ?? [],
        })),
        prs: auto?.prs ?? [],
      });
      m.set(b.name, automatic.get(b.name)!);
    } else {
      m.set(b.name, choiceOf(b));
    }
  }
  return m;
}

/** True when following compare-with from `start` comes back to `start`. */
function loops(m: ReadonlyMap<string, Choice>, start: string): boolean {
  const seen = new Set([start]);
  let x = m.get(start)?.compareWith ?? null;
  while (x && !seen.has(x)) {
    seen.add(x);
    x = m.get(x)?.compareWith ?? null;
  }
  return x === start;
}

/** Prototype `compareMap` loop rule: walk in name order; a loop falls back to the default branch. */
function breakLoops(m: Map<string, Choice>, def: string) {
  for (const b of [...m.keys()].sort()) {
    if (loops(m, b))
      m.set(b, { compareWith: def, why: 'default', whyPr: null, ambiguous: null, loop: true });
  }
}

/** Would these overrides make `branch`'s compare-with chain come back to itself? */
export function createsLoop(
  snapshot: TreeSnapshot,
  overrides: Overrides,
  branch: string,
  auto: AutomaticInputs | null = null,
): boolean {
  let g: CommitGraph | null = null;
  return loops(
    rawChoices(snapshot, overrides, auto, () => (g ??= graphOf(snapshot))),
    branch,
  );
}

/** The snapshot as it looks with the current overrides. Unchanged branches are returned as-is. */
export function applyOverrides(
  snapshot: TreeSnapshot,
  overrides: Overrides,
  auto: AutomaticInputs | null = null,
): TreeSnapshot {
  let g: CommitGraph | null = null;
  const graph = () => (g ??= graphOf(snapshot));
  const m = rawChoices(snapshot, overrides, auto, graph);
  breakLoops(m, snapshot.defaultBranch);

  const byName = new Map(snapshot.branches.map((b) => [b.name, b]));
  let changed = false;
  const branches = snapshot.branches.map((b): BranchNode => {
    const c = m.get(b.name)!;
    const sameTarget = c.compareWith === b.compareWith;
    if (
      sameTarget &&
      c.why === b.why &&
      c.whyPr === b.whyPr &&
      c.ambiguous === b.ambiguous &&
      c.loop === b.loop
    )
      return b;
    changed = true;
    const node: BranchNode = { ...b, ...c };
    if (!sameTarget) {
      const target = c.compareWith ? byName.get(c.compareWith) : undefined;
      if (target) {
        const ab = graph().aheadBehind(b.headSha, target.headSha);
        node.ahead = ab.ahead;
        node.behind = ab.behind;
        node.mergeBase = graph().mergeBase(b.headSha, target.headSha);
      } else {
        node.ahead = 0;
        node.behind = 0;
        node.mergeBase = null;
      }
    }
    return node;
  });
  return changed ? { ...snapshot, branches } : snapshot;
}

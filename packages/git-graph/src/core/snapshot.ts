// Build the TreeSnapshot the page draws. `merged` comes from `detectMerged`: the PR record, else the
// content facts the caller got from `detectMergedWithFallbacks` (T3b runs it in the sync job).
// Lazy table (T6a): with `visible`, ahead/behind/merge base and the drawn commits are computed only for
// the visible rows and the rows on their compare-with chains; the other rows get `NOT_COMPUTED`.
import { CommitGraph, type CommitInput } from './graph';
import {
  branchOrder,
  pickCompareWith,
  type BranchInput,
  type Lookup,
  type PrRecord,
} from './compare-with';
import { detectMerged, type ContentFactsLookup } from './merged';
import type { BranchNode, CiState, SnapshotCommit, TreeSnapshot } from '../types';

export interface SnapshotBranchInput extends BranchInput {
  /** milestone 5: the push webhook saw this branch being created */
  recorded?: boolean;
}

export interface SnapshotInput {
  defaultBranch: string;
  branches: readonly SnapshotBranchInput[];
  /** the commit graph, or the raw commits to build it from */
  graph: CommitGraph | readonly CommitInput[];
  prs?: readonly PrRecord[];
  overrides?: Lookup;
  /** CI state by commit SHA (`CommitCi`); missing → 'none' */
  ci?: ReadonlyMap<string, CiState> | Readonly<Record<string, CiState>>;
  /** the commit list was cut short when it was read */
  truncated?: boolean;
  /** content-rule facts per branch name (`detectMergedWithFallbacks(...).content`); missing → PR rule only */
  content?: ContentFactsLookup;
  /** newest own commits kept per branch in `commits` (the page shows the last few plus "+N"). Default 50. */
  maxCommitsPerBranch?: number;
  /**
   * T6a lazy table: the branch names the page shows. Only these rows and the rows on their compare-with
   * chains get ahead/behind/mergeBase and commits in `commits`; the others get
   * `ahead = behind = NOT_COMPUTED` and `mergeBase = null`. Every row still gets compare-with (the tree
   * layout needs every row's parent), `merged`, `pr` and `ci`. Default: every row is computed.
   */
  visible?: readonly string[];
}

/** `BranchNode.ahead` / `.behind` for rows the lazy table did not compute (`buildSnapshot({ visible })`). */
// VERIFY: `BranchNodeSchema` (packages/shared) rejects -1 until the T6a request in
// tasks/CONTRACT_REQUESTS.md is applied; T6b uses the same sentinel.
export const NOT_COMPUTED = -1;

export function buildSnapshot(input: SnapshotInput): TreeSnapshot {
  const graph = input.graph instanceof CommitGraph ? input.graph : new CommitGraph(input.graph);
  const prs = [...(input.prs ?? [])].sort((a, b) => a.number - b.number);
  const ci = input.ci instanceof Map ? input.ci : new Map(Object.entries(input.ci ?? {}));
  const cap = input.maxCommitsPerBranch ?? 50;
  const content =
    input.content instanceof Map ? input.content : new Map(Object.entries(input.content ?? {}));
  const choices = pickCompareWith({
    graph,
    defaultBranch: input.defaultBranch,
    branches: input.branches,
    overrides: input.overrides,
    prs,
  });
  const byName = new Map(input.branches.map((b) => [b.name, b]));
  // Visible rows plus their chains: the same set `pickCompareWith({ only })` keeps.
  const computed = input.visible ? chainsOf(input.visible, input.defaultBranch, choices) : null;
  const drawn = new Set<string>();
  const branches: BranchNode[] = [];

  for (const name of branchOrder(input.defaultBranch, choices)) {
    const b = byName.get(name)!;
    const c = choices.get(name)!;
    const isDefault = name === input.defaultBranch;
    const target = c.compareWith ? byName.get(c.compareWith)! : null;
    let ab: { ahead: number; behind: number; mergeBase: string | null };
    if (computed && !computed.has(name)) {
      ab = { ahead: NOT_COMPUTED, behind: NOT_COMPUTED, mergeBase: null };
    } else {
      // One walk for ahead, behind and the merge base.
      ab = target
        ? graph.compare(b.headSha, target.headSha)
        : { ahead: 0, behind: 0, mergeBase: null };
      const own = target
        ? graph.aheadCommits(b.headSha, target.headSha).slice(-cap)
        : graph.reachableTail(b.headSha, cap);
      for (const sha of own) drawn.add(sha);
    }

    const pr = prs.filter((p) => p.headRef === name).pop();
    branches.push({
      name,
      headSha: b.headSha,
      headCommittedAt: graph.has(b.headSha) ? graph.commit(b.headSha).committedAt : null,
      isDefault,
      compareWith: c.compareWith,
      why: c.why,
      whyPr: c.whyPr,
      ambiguous: c.ambiguous,
      loop: c.loop,
      ahead: ab.ahead,
      behind: ab.behind,
      mergeBase: ab.mergeBase,
      merged: isDefault
        ? null
        : detectMerged({ graph, branch: b, target, prs, content: content.get(name) }),
      pr: pr
        ? { number: pr.number, state: pr.state, baseRef: pr.baseRef, author: pr.author ?? null }
        : null,
      ci: ci.get(b.headSha) ?? 'none',
      recorded: b.recorded ?? false,
    });
  }

  // Drawn commits in graph order (parents before children).
  const commits: SnapshotCommit[] = graph
    .sortTopological([...drawn])
    .map((sha) => graph.commit(sha));

  return {
    defaultBranch: input.defaultBranch,
    branches,
    commits,
    truncated: Boolean(input.truncated) || graph.hasMissingParents,
  };
}

/** `names` and every branch on their compare-with chains, plus the default branch. */
function chainsOf(
  names: readonly string[],
  defaultBranch: string,
  choices: ReadonlyMap<string, { compareWith: string | null }>,
): Set<string> {
  const out = new Set<string>();
  if (choices.has(defaultBranch)) out.add(defaultBranch);
  for (const name of names) {
    let x: string | null = choices.has(name) ? name : null;
    while (x && !out.has(x)) {
      out.add(x);
      x = choices.get(x)?.compareWith ?? null;
    }
  }
  return out;
}

// Build the TreeSnapshot the page draws. `merged` comes from `detectMerged`: the PR record, else the
// content facts the caller got from `detectMergedWithFallbacks` (T3b runs it in the sync job).
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
}

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
  const drawn = new Set<string>();
  const branches: BranchNode[] = [];

  for (const name of branchOrder(input.defaultBranch, choices)) {
    const b = byName.get(name)!;
    const c = choices.get(name)!;
    const isDefault = name === input.defaultBranch;
    const target = c.compareWith ? byName.get(c.compareWith)! : null;
    const ab = target ? graph.aheadBehind(b.headSha, target.headSha) : { ahead: 0, behind: 0 };
    const own = target ? graph.aheadCommits(b.headSha, target.headSha) : graph.reachable(b.headSha);
    for (const sha of own.slice(-cap)) drawn.add(sha);

    const pr = prs.filter((p) => p.headRef === name).pop();
    branches.push({
      name,
      headSha: b.headSha,
      isDefault,
      compareWith: c.compareWith,
      why: c.why,
      whyPr: c.whyPr,
      ambiguous: c.ambiguous,
      loop: c.loop,
      ahead: ab.ahead,
      behind: ab.behind,
      mergeBase: target ? graph.mergeBase(b.headSha, target.headSha) : null,
      merged: isDefault
        ? null
        : detectMerged({ graph, branch: b, target, prs, content: content.get(name) }),
      pr: pr ? { number: pr.number, state: pr.state, baseRef: pr.baseRef } : null,
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

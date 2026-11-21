// Build the TreeSnapshot the page draws. `merged` comes from the PR record only (prototype `prMerge`);
// T3a adds the content rule.
import { CommitGraph, type CommitInput } from './graph';
import {
  branchOrder,
  pickCompareWith,
  type BranchInput,
  type Lookup,
  type PrRecord,
} from './compare-with';
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
  /** newest own commits kept per branch in `commits` (the page shows the last few plus "+N"). Default 50. */
  maxCommitsPerBranch?: number;
}

/** Prototype `prMerge`: the newest merged PR for the branch, and how many commits came after its head. */
export function prMerge(
  graph: CommitGraph,
  branch: { name: string; headSha: string },
  prs: readonly PrRecord[],
): { pr: PrRecord; newCommits: number } | null {
  const merged = prs.filter((p) => p.headRef === branch.name && p.state === 'merged');
  const pr = merged.sort((a, b) => a.number - b.number).pop();
  if (!pr) return null;
  if (pr.headSha === branch.headSha) return { pr, newCommits: 0 };
  // Without the PR's head commit we cannot count what came after it, so we make no claim.
  if (!pr.headSha || !graph.has(pr.headSha)) return null;
  return { pr, newCommits: graph.aheadBehind(branch.headSha, pr.headSha).ahead };
}

export function buildSnapshot(input: SnapshotInput): TreeSnapshot {
  const graph = input.graph instanceof CommitGraph ? input.graph : new CommitGraph(input.graph);
  const prs = [...(input.prs ?? [])].sort((a, b) => a.number - b.number);
  const ci = input.ci instanceof Map ? input.ci : new Map(Object.entries(input.ci ?? {}));
  const cap = input.maxCommitsPerBranch ?? 50;
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

    const m = isDefault ? null : prMerge(graph, b, prs);
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
      merged: m
        ? {
            via: 'pr',
            prNumber: m.pr.number,
            method: m.pr.mergeMethod ?? null,
            into: m.pr.baseRef,
            newCommits: m.newCommits,
          }
        : null,
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

// Merged-state detection (tasks/T-branch-tree.md → "Merged-state rules"). Port of the prototype's
// `prMerge` + `contentMerged` (via `mergeNote`): the PR record first, then the content check against the
// branch's compare-with target. Pure: the content facts (patch matches, merge-tree result) come from the
// throwaway workspace (`detectMergedWithFallbacks` in '@app/git-graph/git'); only ids and booleans.
import type { CommitGraph } from './graph';
import type { PrRecord } from './compare-with';
import { mergedByContent } from './equivalence';
import type { BranchMerged, MergeMethod } from '../types';

export interface BranchRef {
  name: string;
  headSha: string;
}

/** What the content check found for one branch (from the workspace). */
export interface ContentFacts {
  /** branch commits whose patch id matches a commit in the target (`git cherry T B` "-" lines) */
  patchMatched: readonly string[];
  /** `git merge-tree --write-tree T B` gave T's own tree: everything on B is already in T */
  mergeTreeEqualsTarget: boolean;
}

export type ContentFactsLookup =
  ReadonlyMap<string, ContentFacts> | Readonly<Record<string, ContentFacts>>;

/** Prototype `prMerge`: the newest merged PR for the branch, and how many commits came after its head. */
export function prMerge(
  graph: CommitGraph,
  branch: BranchRef,
  prs: readonly PrRecord[],
): { pr: PrRecord; newCommits: number } | null {
  const merged = prs.filter((p) => p.headRef === branch.name && p.state === 'merged');
  const pr = merged.sort((a, b) => a.number - b.number).pop();
  if (!pr) return null;
  if (pr.headSha === branch.headSha) return { pr, newCommits: 0 };
  // Without the PR's head commit we cannot count what came after it, so we make no claim.
  if (!pr.headSha || !graph.has(pr.headSha)) return null;
  // `rev-list --count <pr.headSha>..B`
  return { pr, newCommits: graph.aheadBehind(branch.headSha, pr.headSha).ahead };
}

export interface DetectMergedInput {
  graph: CommitGraph;
  branch: BranchRef;
  /** the branch's compare-with target; null for the default branch (never marked) */
  target: BranchRef | null;
  prs: readonly PrRecord[];
  /** content facts for this branch; absent → the content rule is not applied */
  content?: ContentFacts | null;
}

/**
 * Rule 1 (PR record), else rule 2 (content in the target). Null = not marked: default branch, nothing
 * ahead of the target (the row already shows ↑0), not every commit done, or no content facts.
 */
export function detectMerged(input: DetectMergedInput): BranchMerged | null {
  const { graph, branch, target } = input;
  if (!target) return null;
  const m = prMerge(graph, branch, input.prs);
  if (m) {
    return {
      via: 'pr',
      prNumber: m.pr.number,
      method: m.pr.mergeMethod ?? inferMergeMethod(graph, m.pr),
      into: m.pr.baseRef,
      newCommits: m.newCommits,
      mergeCommitSha: m.pr.mergeCommitSha ?? null,
    };
  }
  if (!input.content) return null;
  const via = mergedByContent({
    ahead: graph.aheadCommits(branch.headSha, target.headSha),
    isMerge: (sha) => graph.isMerge(sha),
    patchMatched: input.content.patchMatched,
    contentInTarget: input.content.mergeTreeEqualsTarget,
  });
  if (!via) return null;
  return {
    via,
    prNumber: null,
    method: null,
    into: target.name,
    newCommits: 0,
    mergeCommitSha: null,
  };
}

/**
 * How GitHub merged a PR, from its `merge_commit_sha` in the commits-only graph (GitHub's PR API does not
 * say). Two or more parents → `merge`. Otherwise a rebase merge writes every rebased commit with the same
 * committer timestamp, so a first parent with the same timestamp → `rebase`; else `squash` (a one-commit
 * rebase looks exactly like a squash). Null when the merge commit is not in the graph.
 */
// VERIFY: GitHub gives all commits of one rebase merge the same committer date (observed, not documented).
export function inferMergeMethod(graph: CommitGraph, pr: PrRecord): MergeMethod | null {
  const sha = pr.mergeCommitSha;
  if (!sha || !graph.has(sha)) return null;
  if (graph.isMerge(sha)) return 'merge';
  const c = graph.commit(sha);
  const parent = c.parents[0];
  if (parent && graph.has(parent) && graph.commit(parent).committedAt === c.committedAt)
    return 'rebase';
  return 'squash';
}

/**
 * Does this branch need the content check? Only when rule 1 gives nothing and the branch has commits
 * ahead of its target. Cheap (graph only); used to pick what goes into the throwaway workspace.
 */
export function needsContentCheck(
  graph: CommitGraph,
  branch: BranchRef,
  target: BranchRef | null,
  prs: readonly PrRecord[],
): boolean {
  if (!target || target.headSha === branch.headSha) return false;
  if (prMerge(graph, branch, prs)) return false;
  return graph.aheadBehind(branch.headSha, target.headSha).ahead > 0;
}

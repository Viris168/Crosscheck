// Merged-state detection over real git (tasks/T-branch-tree.md → "Merged-state rules"; task T3a).
// Rule 1 (PR record) runs on the commit graph alone. Rule 2 (content) needs trees/blobs, so the
// remaining branches go through ONE throwaway workspace (`withContentWorkspace`). The cache clone is
// only read. Results are ids/booleans/counts; nothing here logs.
import { CommitGraph, type CommitInput } from '../core/graph';
import {
  pickCompareWith,
  type BranchInput,
  type Lookup,
  type PrRecord,
} from '../core/compare-with';
import { detectMerged, needsContentCheck, type BranchRef, type ContentFacts } from '../core/merged';
import type { BranchMerged } from '../types';
import { withContentWorkspace, type ContentWorkspace, type GitAuth } from './workspace';

export interface MergedGraphInput {
  defaultBranch: string;
  branches: readonly BranchInput[];
  graph: CommitGraph | readonly CommitInput[];
  prs?: readonly PrRecord[];
  /** `CompareOverride` rows, so the targets match the snapshot's compare-with picks */
  overrides?: Lookup;
}

export interface DetectMergedOptions {
  /** content checks per sync (spec: 50). Newest branch heads go first; the rest are `skipped`. */
  maxBranches?: number;
  /** per-branch budget for the content check (spec: 10 s) */
  perBranchTimeoutMs?: number;
  /** clone + config of the workspace (default 60 s) */
  setupTimeoutMs?: number;
}

export interface DetectMergedResult {
  /** `BranchNode.merged` for every branch (null = not marked) */
  merged: Map<string, BranchMerged | null>;
  /** content facts for the branches that were checked; pass to `buildSnapshot({ content })` */
  content: Map<string, ContentFacts>;
  /** names that needed a content check but did not get one (over `maxBranches`) */
  skipped: string[];
  /** names whose content check failed or timed out (not marked; retried next sync) */
  failed: string[];
}

/**
 * Rule 1 on the graph, then rule 2 in one throwaway workspace for the branches that have no merged PR
 * and commits ahead of their compare-with target.
 */
export async function detectMergedWithFallbacks(
  cacheGitDir: string,
  auth: GitAuth,
  input: MergedGraphInput,
  opts: DetectMergedOptions = {},
): Promise<DetectMergedResult> {
  const maxBranches = opts.maxBranches ?? 50;
  const perBranch = opts.perBranchTimeoutMs ?? 10_000;
  const graph = input.graph instanceof CommitGraph ? input.graph : new CommitGraph(input.graph);
  const prs = input.prs ?? [];
  const choices = pickCompareWith({
    graph,
    defaultBranch: input.defaultBranch,
    branches: input.branches,
    overrides: input.overrides,
    prs,
  });
  const byName = new Map(input.branches.map((b) => [b.name, b]));
  const targetOf = (name: string): BranchRef | null => {
    const t = choices.get(name)?.compareWith;
    return t ? (byName.get(t) ?? null) : null;
  };

  const todo = input.branches
    .filter((b) => b.name !== input.defaultBranch)
    .filter((b) => needsContentCheck(graph, b, targetOf(b.name), prs))
    // newest heads first (most likely what people look at), then by name for a stable order
    .sort(
      (a, b) =>
        Date.parse(graph.commit(b.headSha).committedAt) -
          Date.parse(graph.commit(a.headSha).committedAt) || (a.name < b.name ? -1 : 1),
    );
  const checked = todo.slice(0, maxBranches);
  const skipped = todo.slice(maxBranches).map((b) => b.name);
  const content = new Map<string, ContentFacts>();
  const failed: string[] = [];

  if (checked.length) {
    const setup = opts.setupTimeoutMs ?? 60_000;
    try {
      await withContentWorkspace(
        cacheGitDir,
        auth,
        async (ws) => {
          const treeOf = new Map<string, Promise<string>>();
          for (const b of checked) {
            const target = targetOf(b.name)!;
            try {
              content.set(
                b.name,
                await contentFacts(ws, graph, b, target, treeOf, Date.now() + perBranch),
              );
            } catch {
              if (ws.signal.aborted) throw new Error('workspace aborted');
              failed.push(b.name);
            }
          }
        },
        { timeoutMs: setup + checked.length * perBranch },
      );
    } catch {
      // Workspace could not be opened, or the whole budget ran out: the rest count as failed.
      for (const b of checked)
        if (!content.has(b.name) && !failed.includes(b.name)) failed.push(b.name);
    }
  }

  const merged = new Map<string, BranchMerged | null>();
  for (const b of input.branches) {
    merged.set(
      b.name,
      b.name === input.defaultBranch
        ? null
        : detectMerged({
            graph,
            branch: b,
            target: targetOf(b.name),
            prs,
            content: content.get(b.name),
          }),
    );
  }
  return { merged, content, skipped, failed };
}

async function contentFacts(
  ws: ContentWorkspace,
  graph: CommitGraph,
  branch: BranchRef,
  target: BranchRef,
  treeOf: Map<string, Promise<string>>,
  deadline: number,
): Promise<ContentFacts> {
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('branch timed out');
    return { timeoutMs: ms };
  };
  // `git cherry T B` "-" lines = patch matches.
  const patchMatched = await ws.cherryMatched(target.headSha, branch.headSha, left());
  const matched = new Set(patchMatched);
  const ahead = graph.aheadCommits(branch.headSha, target.headSha);
  const open = ahead.filter((sha) => !graph.isMerge(sha) && !matched.has(sha));
  // Everything already matched by patch: no test merge needed (saves fetching trees).
  if (!open.length) return { patchMatched, mergeTreeEqualsTarget: false };
  let tree = treeOf.get(target.headSha);
  if (!tree) {
    tree = ws.treeId(target.headSha, left());
    tree.catch(() => {});
    treeOf.set(target.headSha, tree);
  }
  const [mergeTree, targetTree] = await Promise.all([
    ws.mergeTreeId(target.headSha, branch.headSha, left()),
    tree,
  ]);
  return { patchMatched, mergeTreeEqualsTarget: mergeTree !== null && mergeTree === targetTree };
}

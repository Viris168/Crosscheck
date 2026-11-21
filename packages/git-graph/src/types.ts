// TODO(T0): import from @app/shared. These mirror the contracts in tasks/T-branch-tree.md ("Contracts")
// until T0 merges; keep the shapes identical so the swap is an import change only.

export type CiState = 'success' | 'failure' | 'pending' | 'neutral' | 'none';
export type MergedVia = 'pr' | 'rebased' | 'squashed';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type PullRequestState = 'open' | 'closed' | 'merged';
export type CompareWhy = 'override' | 'pr' | 'recorded' | 'inferred' | 'default';

export interface SnapshotCommit {
  sha: string;
  parents: string[];
  /** ISO 8601 */
  committedAt: string;
}

export interface BranchNode {
  name: string;
  headSha: string;
  isDefault: boolean;
  /** null only for the default branch */
  compareWith: string | null;
  why: CompareWhy;
  /** rule 'pr' */
  whyPr: number | null;
  /** rule 'recorded' with several candidates */
  ambiguous: number | null;
  /** fell back to default because of a loop */
  loop: boolean;
  ahead: number;
  behind: number;
  mergeBase: string | null;
  merged: {
    via: MergedVia;
    prNumber: number | null;
    method: MergeMethod | null;
    into: string;
    newCommits: number;
  } | null;
  /** newest PR whose head.ref is this branch */
  pr: { number: number; state: PullRequestState; baseRef: string } | null;
  ci: CiState;
  /** milestone 5 */
  recorded: boolean;
}

export interface TreeSnapshot {
  defaultBranch: string;
  branches: BranchNode[];
  /** only what the page draws */
  commits: SnapshotCommit[];
  truncated: boolean;
}

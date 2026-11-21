// Contracts from @app/shared (tasks/T-branch-tree.md → "Contracts"). Type-only imports from the
// browser-safe entry, so the pure engine stays free of runtime dependencies.
import type { BranchNode, TreeCommit } from '@app/shared/client';

export type {
  BranchNode,
  CiState,
  CompareWhy,
  MergedVia,
  MergeMethod,
  PullRequestState,
  TreeSnapshot,
} from '@app/shared/client';

export type SnapshotCommit = TreeCommit;
/** `BranchNode.merged` when set. */
export type BranchMerged = NonNullable<BranchNode['merged']>;

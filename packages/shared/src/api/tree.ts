import { z } from 'zod';
import {
  CiState,
  CompareWhy,
  ErrorCode,
  MergedVia,
  PullRequestState,
  TreeSyncStatus,
} from '../enums';
import { IsoDate } from './common';
import { MergeMethod } from './pulls';
import { RepoParams } from './repos';

// Branch tree (tasks/T-branch-tree.md → "Contracts"). Browser-safe: no `node:` imports.
// Privacy: SHAs, parent SHAs, commit timestamps, ref names, PR numbers/state and CI states only —
// never commit messages, author emails, file names or contents.

export const TREE_MAX_BRANCHES = 2000;
export const TREE_MAX_COMMITS = 20_000;
export const TREE_MAX_NAME = 255;

/** Full commit id: 40 hex (SHA-1) or 64 hex (SHA-256 repos). */
export const Sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, 'must be a full commit SHA');
export const BranchName = z.string().min(1).max(TREE_MAX_NAME);

export const TreeParams = RepoParams;

export const BranchMergedSchema = z.object({
  via: z.enum(MergedVia),
  /** Set when via = 'pr'. */
  prNumber: z.number().int().positive().nullable(),
  /** From the PR (via = 'pr'); null for content-detected merges. */
  method: z.enum(MergeMethod).nullable(),
  /** The branch it was merged into (its compare-with target). */
  into: BranchName,
  /** Commits on the branch after the PR's head at merge time (`rev-list --count <pr.headSha>..B`). */
  newCommits: z.number().int().nonnegative(),
  /**
   * The PR's `merge_commit_sha` (via = 'pr'): the merge commit, the squash commit, or the last rebased
   * commit. The page draws it as a square when `method = 'squash'`. Defaults to null for older snapshots.
   */
  mergeCommitSha: Sha.nullable().default(null),
});

export const BranchPrSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(PullRequestState),
  baseRef: BranchName,
});

export const BranchNodeSchema = z.object({
  name: BranchName,
  headSha: Sha,
  isDefault: z.boolean(),
  /** null only for the default branch. Required (not optional): send null explicitly. */
  compareWith: BranchName.nullable(),
  why: z.enum(CompareWhy),
  /** PR number when why = 'pr'. */
  whyPr: z.number().int().positive().nullable(),
  /** Candidate count when why = 'recorded' had several. */
  ambiguous: z.number().int().min(2).nullable(),
  /** Fell back to the default branch because the choices formed a loop. */
  loop: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  mergeBase: Sha.nullable(),
  merged: BranchMergedSchema.nullable(),
  /** Newest PR whose head.ref is this branch. */
  pr: BranchPrSchema.nullable(),
  ci: z.enum(CiState),
  /** Milestone 5: compare-with came from what the push webhook recorded. */
  recorded: z.boolean(),
});
export type BranchNode = z.infer<typeof BranchNodeSchema>;

export const TreeCommitSchema = z.object({
  sha: Sha,
  parents: z.array(Sha).max(64),
  committedAt: IsoDate,
});
export type TreeCommit = z.infer<typeof TreeCommitSchema>;

/** Stored in `RepoGraph.snapshot`. Only the commits the page draws. */
export const TreeSnapshotSchema = z
  .object({
    defaultBranch: BranchName,
    branches: z.array(BranchNodeSchema).max(TREE_MAX_BRANCHES),
    commits: z.array(TreeCommitSchema).max(TREE_MAX_COMMITS),
    truncated: z.boolean(),
  })
  .superRefine((s, ctx) => {
    s.branches.forEach((b, i) => {
      const isDefault = b.name === s.defaultBranch;
      if (b.isDefault !== isDefault)
        ctx.addIssue({
          code: 'custom',
          path: ['branches', i, 'isDefault'],
          message: 'isDefault must match defaultBranch',
        });
      if (!isDefault && b.compareWith === null)
        ctx.addIssue({
          code: 'custom',
          path: ['branches', i, 'compareWith'],
          message: 'compareWith may be null only for the default branch',
        });
    });
  });
export type TreeSnapshot = z.infer<typeof TreeSnapshotSchema>;

/** GET /api/repos/:repoId/tree?at=<ISO> (`at`: milestone 8 only). */
export const GetTreeQuery = z.object({
  at: IsoDate.optional(),
});

export const GetTreeResponse = z.object({
  status: z.enum(TreeSyncStatus),
  syncedAt: IsoDate.nullable(),
  errorCode: z.enum(ErrorCode).nullable(),
  snapshot: TreeSnapshotSchema.nullable(),
  /** Write access: may set compare-with overrides. */
  canEdit: z.boolean(),
});
export type GetTreeResponse = z.infer<typeof GetTreeResponse>;

/** POST /api/repos/:repoId/tree/sync — view access; rate limited 1/min/repo. */
export const SyncTreeResponse = z.object({ queued: z.literal(true) });

/** PUT /api/repos/:repoId/tree/compare-with — write access. compareWith null clears the override. */
export const SetCompareWithBody = z.object({
  branch: BranchName,
  compareWith: BranchName.nullable(),
});
export const SetCompareWithResponse = z.object({ branch: BranchNodeSchema });

/** GET /api/repos/:repoId/tree/compare?a=<branch>&b=<branch> (milestone 6). */
export const CompareQuery = z.object({
  a: BranchName,
  b: BranchName,
});
export const CompareResponse = z.object({
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  mergeBase: Sha.nullable(),
});

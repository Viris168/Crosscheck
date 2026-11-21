// Local contract extensions for T6b (milestone 6), until tasks/CONTRACT_REQUESTS.md → "[Task T6b]" lands
// in packages/shared. Browser-safe: used by GET /tree and by the page. Drop each piece once applied.
import {
  BranchName,
  BranchNodeSchema,
  GetTreeQuery,
  GetTreeResponse,
  TREE_MAX_BRANCHES,
  TreeSnapshotSchema,
  type BranchNode,
} from '@app/shared/client';
import { z } from 'zod';

/** Most branch names one GET /tree?visible= may name (a screen holds ~20 rows; overscan included). */
export const TREE_MAX_VISIBLE = 200;

/** `ahead`/`behind` of a row the server did not compute (T6a lazy table). */
export const NOT_COMPUTED = -1;

/** GET /tree query + `visible` (repeat the key: `?visible=a&visible=b`). */
export const GetTreeScaleQuery = GetTreeQuery.extend({
  visible: z.array(BranchName).max(TREE_MAX_VISIBLE).optional(),
});

/** BranchNode whose counts may be NOT_COMPUTED. */
export const LazyBranchNodeSchema = BranchNodeSchema.extend({
  ahead: z.number().int().min(NOT_COMPUTED),
  behind: z.number().int().min(NOT_COMPUTED),
});

export const LazyTreeSnapshotSchema = TreeSnapshotSchema.safeExtend({
  branches: z.array(LazyBranchNodeSchema).max(TREE_MAX_BRANCHES),
});

export const LazyGetTreeResponse = GetTreeResponse.extend({
  snapshot: LazyTreeSnapshotSchema.nullable(),
});

/**
 * Response header on a 200 from GET /tree: PR numbers in the snapshot opened by the viewer (comma
 * separated), for the "mine" filter. Workaround until `BranchPrSchema.author` + `viewerLogin` land.
 */
export const MINE_PRS_HEADER = 'x-tree-mine-prs';

export const isComputed = (b: Pick<BranchNode, 'ahead' | 'behind'>) =>
  b.ahead >= 0 && b.behind >= 0;

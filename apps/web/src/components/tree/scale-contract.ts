// Branch tree at scale (T6b): the lazy-table schemas now live in @app/shared (`GetTreeQuery.visible`,
// `ahead`/`behind` = -1). What stays here is client-side.
import type { BranchNode } from '@app/shared/client';

/** `ahead` / `behind` for rows the lazy table did not compute (same value as `NOT_COMPUTED` in @app/git-graph). */
export const NOT_COMPUTED = -1;

/** GET /tree response header: PR numbers in the snapshot authored by the viewer (the "mine" filter). */
export const MINE_PRS_HEADER = 'x-tree-mine-prs';

export const isComputed = (b: Pick<BranchNode, 'ahead' | 'behind'>) =>
  b.ahead >= 0 && b.behind >= 0;

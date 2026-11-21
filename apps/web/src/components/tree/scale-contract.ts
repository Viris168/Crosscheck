// Branch tree at scale (T6b): the lazy-table schemas now live in @app/shared (`GetTreeQuery.visible`,
// `ahead`/`behind` = -1). What stays here is client-side.
import type { BranchNode } from '@app/shared/client';

/** `ahead` / `behind` for rows the lazy table did not compute (same value as `NOT_COMPUTED` in @app/git-graph). */
export const NOT_COMPUTED = -1;

export const isComputed = (b: Pick<BranchNode, 'ahead' | 'behind'>) =>
  b.ahead >= 0 && b.behind >= 0;

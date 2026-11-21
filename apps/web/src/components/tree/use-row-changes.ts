'use client';

import type { TreeSnapshot } from '@app/shared/client';
import { useEffect, useRef, useState } from 'react';

/** A branch whose head moved flashes this long; a new branch's slide-in is shorter (CSS). */
export const FLASH_MS = 2000;
/** A deleted branch fades out for this long before the new tree is drawn. */
export const LEAVE_MS = 400;

export type RowChanges = {
  /** Head SHA changed since the last render. */
  flash: ReadonlySet<string>;
  /** New since the last render. */
  entering: ReadonlySet<string>;
  /** Gone in the new snapshot; still drawn (fading) until LEAVE_MS. */
  leaving: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();
export const NO_CHANGES: RowChanges = { flash: NONE, entering: NONE, leaving: NONE };

/** Branch-level differences between two snapshots, by name and head SHA. */
export function diffBranches(prev: TreeSnapshot, next: TreeSnapshot) {
  const before = new Map(prev.branches.map((b) => [b.name, b.headSha]));
  const after = new Set(next.branches.map((b) => b.name));
  const changed = new Set<string>();
  const added = new Set<string>();
  for (const b of next.branches) {
    const head = before.get(b.name);
    if (head === undefined) added.add(b.name);
    else if (head !== b.headSha) changed.add(b.name);
  }
  const removed = new Set([...before.keys()].filter((n) => !after.has(n)));
  return { changed, added, removed };
}

/**
 * The snapshot to draw plus which rows to animate. The first render animates nothing. When branches
 * were deleted, the previous snapshot stays on screen with those rows fading for LEAVE_MS, then the new
 * one is drawn; rows whose head moved flash and new rows slide in, for FLASH_MS.
 */
export function useRowChanges(snapshot: TreeSnapshot): {
  shown: TreeSnapshot;
  changes: RowChanges;
} {
  const [state, setState] = useState(() => ({ shown: snapshot, changes: NO_CHANGES }));
  const shownRef = useRef(snapshot);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const prev = shownRef.current;
    if (prev === snapshot) return;
    const { changed, added, removed } = diffBranches(prev, snapshot);

    const show = () => {
      shownRef.current = snapshot;
      if (!changed.size && !added.size) {
        // Nothing to animate (counts, PRs, CI…): keep any flash that is still running.
        setState((s) => ({ shown: snapshot, changes: { ...s.changes, leaving: NONE } }));
        return;
      }
      clearTimeout(flashTimer.current);
      setState({ shown: snapshot, changes: { flash: changed, entering: added, leaving: NONE } });
      flashTimer.current = setTimeout(
        () => setState((s) => ({ ...s, changes: NO_CHANGES })),
        FLASH_MS,
      );
    };

    if (!removed.size) {
      show();
      return;
    }
    setState((s) => ({ ...s, changes: { ...s.changes, leaving: removed } }));
    const leave = setTimeout(show, LEAVE_MS);
    return () => clearTimeout(leave);
  }, [snapshot]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  return state;
}

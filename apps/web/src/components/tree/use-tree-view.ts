'use client';

import { useCallback, useEffect, useState } from 'react';
import { EMPTY_VIEW, parseView, viewSearch, type TreeView } from './view';

/**
 * Search + filters, kept in the URL (`?q=&f=`) so a filtered tree can be shared and survives reload.
 * Uses `history.replaceState` (no navigation, no server round trip) and follows back/forward.
 */
export function useTreeView(): [TreeView, (next: TreeView) => void] {
  const [view, setView] = useState<TreeView>(() =>
    typeof window === 'undefined' ? EMPTY_VIEW : parseView(window.location.search),
  );
  useEffect(() => {
    const onPop = () => setView(parseView(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const update = useCallback((next: TreeView) => {
    setView(next);
    const { pathname, search, hash } = window.location;
    // VERIFY: Next.js (>= 14.1) keeps its router in sync with a native `history.replaceState`.
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${viewSearch(next, search)}${hash}`,
    );
  }, []);
  return [view, update];
}

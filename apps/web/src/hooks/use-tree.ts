'use client';

import {
  GetTreeResponse,
  SetCompareWithResponse,
  SyncTreeResponse,
  type BranchNode,
} from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/** Live poll interval while the tab is visible (T5c). */
export const TREE_POLL_MS = 3000;
/** No input for this long → polling stops until the user is back (focus, key, pointer, scroll). */
export const TREE_IDLE_MS = 10 * 60_000;
/** How long a Refresh click shows "syncing" while the server has not changed yet. */
export const SYNC_GRACE_MS = 60_000;
/** Response header set by GET /tree (workaround until `GetTreeResponse.liveEvents` lands). */
export const LIVE_EVENTS_HEADER = 'x-tree-live-events';

/** What the page caches: the response plus the validator and the live-events signal (client only). */
export type TreeData = GetTreeResponse & {
  /** ETag of the server state this data came from; sent back as `If-None-Match`. */
  etag?: string;
  /** false when GitHub has sent no git events for this repo yet; null when unknown. */
  liveEvents?: boolean | null;
  /** Set by a Refresh click: show "syncing" until the server changes or the grace period ends. */
  syncRequestedAt?: number;
};

const treeUrl = (repoId: string) => `/api/repos/${encodeURIComponent(repoId)}/tree`;

/**
 * GET /tree with `If-None-Match`: 304 keeps the cached object (same reference, so nothing re-renders).
 * A Refresh click's optimistic "syncing" is kept while the server answers 304, for up to SYNC_GRACE_MS;
 * after that the validator is dropped so the server's own state wins.
 */
export async function fetchTree(repoId: string, cached: TreeData | undefined): Promise<TreeData> {
  const expired =
    cached?.syncRequestedAt !== undefined && Date.now() - cached.syncRequestedAt >= SYNC_GRACE_MS;
  const etag = cached?.etag && !expired ? cached.etag : undefined;
  // `no-store`: the browser must not answer from (or update) its HTTP cache; we revalidate ourselves.
  // VERIFY: with an author-set If-None-Match, fetch hands the 304 to the page (Fetch spec, "HTTP-network-
  // or-cache fetch" skips cache revalidation when the request already has conditional headers).
  const res = await fetch(treeUrl(repoId), {
    cache: 'no-store',
    headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  });
  if (res.status === 304) {
    if (cached && etag) return cached;
    throw new ApiError(304, 'http_error', 'Unexpected 304 for an unconditional request');
  }
  if (!res.ok) throw await ApiError.from(res);
  const body = GetTreeResponse.parse(await res.json());
  const live = res.headers.get(LIVE_EVENTS_HEADER);
  return {
    ...body,
    etag: res.headers.get('etag') ?? undefined,
    liveEvents: live === '1' ? true : live === '0' ? false : null,
  };
}

/**
 * Tracks whether the user has been away (no input) for `ms`. Any input, focus or the tab becoming
 * visible again counts as being back.
 */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    const wake = () => {
      const now = Date.now();
      setIdle(false);
      if (now - last < 1000) return; // pointermove/scroll fire a lot; re-arm at most once a second
      last = now;
      arm();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') wake();
    };
    const events = [
      'pointerdown',
      'pointermove',
      'keydown',
      'wheel',
      'touchstart',
      'scroll',
      'focus',
    ];
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    arm();
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
  return idle;
}

/**
 * Branch tree snapshot, live (T5c): polls every 3 s while the tab is visible, with `If-None-Match`, so
 * an unchanged tree is a bodyless 304. Polling stops after 10 min without input and resumes (with an
 * immediate refetch) on focus. Polling, not websockets (stack rule).
 */
export function useTree(repoId: string) {
  const qc = useQueryClient();
  const idle = useIdle(TREE_IDLE_MS);
  const key = queryKeys.tree(repoId);
  return useQuery({
    queryKey: key,
    queryFn: () => fetchTree(repoId, qc.getQueryData<TreeData>(key)),
    refetchInterval: (q) =>
      idle || (q.state.status === 'error' && !q.state.data) ? false : TREE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** Asks for a fresh sync (rate limited 1/min/repo → 429). */
export function useSyncTree(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/repos/${encodeURIComponent(repoId)}/tree/sync`, SyncTreeResponse, {
        method: 'POST',
      }),
    onSuccess: () => {
      // Show "syncing" right away. Polls that answer 304 keep it (the job has not marked the graph
      // `syncing` yet); the first real change on the server, or SYNC_GRACE_MS, replaces it.
      qc.setQueryData(queryKeys.tree(repoId), (old: TreeData | undefined) =>
        old
          ? { ...old, status: 'syncing' as const, errorCode: null, syncRequestedAt: Date.now() }
          : old,
      );
    },
  });
}

/** Replaces one branch node in the cached tree. */
function patchBranch(
  old: TreeData | undefined,
  name: string,
  fn: (b: BranchNode) => BranchNode,
): TreeData | undefined {
  if (!old?.snapshot) return old;
  return {
    ...old,
    snapshot: {
      ...old.snapshot,
      branches: old.snapshot.branches.map((b) => (b.name === name ? fn(b) : b)),
    },
  };
}

export type SetCompareWith = { branch: string; compareWith: string | null };

/**
 * Sets (or clears, `compareWith: null`) a branch's compare-with override. Write access.
 * Optimistic: the branch shows "set by hand" at once and rolls back if the server says no. Counts and
 * the automatic pick after a clear come from the server's answer; the tree is refetched afterwards
 * because an override can change other branches too (loops).
 */
export function useSetCompareWith(repoId: string) {
  const qc = useQueryClient();
  const key = queryKeys.tree(repoId);
  return useMutation({
    mutationFn: (body: SetCompareWith) =>
      apiFetch(
        `/api/repos/${encodeURIComponent(repoId)}/tree/compare-with`,
        SetCompareWithResponse,
        { method: 'PUT', body: JSON.stringify(body) },
      ),
    onMutate: async ({ branch, compareWith }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TreeData>(key);
      if (compareWith)
        qc.setQueryData(key, (old: TreeData | undefined) =>
          patchBranch(old, branch, (b) => ({
            ...b,
            compareWith,
            why: 'override',
            whyPr: null,
            ambiguous: null,
            loop: false,
          })),
        );
      return { previous };
    },
    onError: (_err, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSuccess: ({ branch }) => {
      qc.setQueryData(key, (old: TreeData | undefined) =>
        patchBranch(old, branch.name, () => branch),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

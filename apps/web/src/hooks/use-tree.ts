'use client';

import { GetTreeResponse, SyncTreeResponse } from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/** Poll interval while the clone/snapshot is being built. */
export const TREE_POLL_MS = 3000;

/** Branch tree snapshot. Polls every 3 s while `status === 'syncing'`; otherwise no polling (T5c). */
export function useTree(repoId: string) {
  return useQuery({
    queryKey: queryKeys.tree(repoId),
    queryFn: () => apiFetch(`/api/repos/${encodeURIComponent(repoId)}/tree`, GetTreeResponse),
    refetchInterval: (q) => (q.state.data?.status === 'syncing' ? TREE_POLL_MS : false),
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
      // Show "syncing" right away: the query polls until the job reports ready or failed.
      // Not refetched here — the job may not have marked the graph `syncing` yet.
      qc.setQueryData(queryKeys.tree(repoId), (old: GetTreeResponse | undefined) =>
        old ? { ...old, status: 'syncing' as const, errorCode: null } : old,
      );
    },
  });
}

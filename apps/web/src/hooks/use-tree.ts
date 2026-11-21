'use client';

import {
  GetTreeResponse,
  SetCompareWithResponse,
  SyncTreeResponse,
  type BranchNode,
} from '@app/shared/client';
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

/** Replaces one branch node in the cached tree. */
function patchBranch(
  old: GetTreeResponse | undefined,
  name: string,
  fn: (b: BranchNode) => BranchNode,
): GetTreeResponse | undefined {
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
      const previous = qc.getQueryData<GetTreeResponse>(key);
      if (compareWith)
        qc.setQueryData(key, (old: GetTreeResponse | undefined) =>
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
      qc.setQueryData(key, (old: GetTreeResponse | undefined) =>
        patchBranch(old, branch.name, () => branch),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

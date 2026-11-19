'use client';

import {
  GetPullResponse,
  ListPullsResponse,
  MergeResponse,
  type MergeMethod,
} from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { isActiveStatus, POLL_MS } from '@/lib/review-status';

export type PullStateFilter = 'open' | 'closed' | 'all';

export function usePulls(repoId: string, state: PullStateFilter) {
  return useQuery({
    queryKey: queryKeys.pulls(repoId, state),
    queryFn: () =>
      apiFetch(`/api/repos/${encodeURIComponent(repoId)}/pulls?state=${state}`, ListPullsResponse),
  });
}

/** PR header + latest review + changed files. Polls while the latest review is in progress. */
export function usePull(repoId: string, number: number) {
  return useQuery({
    queryKey: queryKeys.pull(repoId, number),
    queryFn: () =>
      apiFetch(`/api/repos/${encodeURIComponent(repoId)}/pulls/${number}`, GetPullResponse),
    refetchInterval: (q) => (isActiveStatus(q.state.data?.review?.status) ? POLL_MS : false),
  });
}

/** Merges the PR on GitHub (owner/admin; needs a completed review of the current head). */
export function useMergePull(repoId: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (method: MergeMethod) =>
      apiFetch(`/api/repos/${encodeURIComponent(repoId)}/pulls/${number}/merge`, MergeResponse, {
        method: 'POST',
        body: JSON.stringify({ method }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos', repoId] }),
  });
}

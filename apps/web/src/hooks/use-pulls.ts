'use client';

import { ListPullsResponse } from '@app/shared/client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { GetPullWithHistoryResponse } from '@/lib/pending-contracts';
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
      apiFetch(
        `/api/repos/${encodeURIComponent(repoId)}/pulls/${number}`,
        GetPullWithHistoryResponse,
      ),
    refetchInterval: (q) => (isActiveStatus(q.state.data?.review?.status) ? POLL_MS : false),
  });
}

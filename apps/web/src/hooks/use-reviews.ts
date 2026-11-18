'use client';

import {
  CancelReviewResponse,
  RerunResponse,
  RetryReviewResponse,
  ReviewDetailSchema,
  type ProviderId,
} from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { isActiveStatus, POLL_MS } from '@/lib/review-status';

/** One review; polls every 3s while queued / running / waiting_action. */
export function useReview(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.review(id ?? ''),
    queryFn: () => apiFetch(`/api/reviews/${encodeURIComponent(id!)}`, ReviewDetailSchema),
    enabled: !!id,
    refetchInterval: (q) => (isActiveStatus(q.state.data?.status) ? POLL_MS : false),
  });
}

/** Refresh everything that shows review state for this repo. */
function invalidateRepo(qc: ReturnType<typeof useQueryClient>, repoId: string) {
  void qc.invalidateQueries({ queryKey: ['repos', repoId] });
  void qc.invalidateQueries({ queryKey: ['reviews'] });
  void qc.invalidateQueries({ queryKey: queryKeys.repos, exact: true });
}

export function useRetryReview(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) =>
      apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/retry`, RetryReviewResponse, {
        method: 'POST',
      }),
    onSuccess: () => invalidateRepo(qc, repoId),
  });
}

export function useCancelReview(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) =>
      apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/cancel`, CancelReviewResponse, {
        method: 'POST',
      }),
    onSuccess: () => invalidateRepo(qc, repoId),
  });
}

export function useRerunReview(repoId: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider?: ProviderId) =>
      apiFetch(`/api/repos/${encodeURIComponent(repoId)}/pulls/${number}/rerun`, RerunResponse, {
        method: 'POST',
        body: JSON.stringify(provider ? { provider } : {}),
      }),
    onSuccess: () => invalidateRepo(qc, repoId),
  });
}

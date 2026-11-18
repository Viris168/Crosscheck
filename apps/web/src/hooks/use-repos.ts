'use client';

import {
  GetRepoSettingsResponse,
  PutRepoSettingsResponse,
  RotateIngestTokenResponse,
  WorkflowPrResponse,
} from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { PutRepoSettingsRequest, WorkflowPrRequest } from '@app/shared/client';
import { apiFetch } from '@/lib/api-client';
import { ListReposWithLastReviewResponse } from '@/lib/pending-contracts';
import { queryKeys } from '@/lib/query-keys';

export function useRepos() {
  return useQuery({
    queryKey: queryKeys.repos,
    queryFn: () => apiFetch('/api/repos', ListReposWithLastReviewResponse),
  });
}

export function useRepoSettings(repoId: string) {
  return useQuery({
    queryKey: queryKeys.repoSettings(repoId),
    queryFn: () => apiFetch(`/api/repos/${enc(repoId)}/settings`, GetRepoSettingsResponse),
  });
}

export function useUpdateRepoSettings(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof PutRepoSettingsRequest>) =>
      apiFetch(`/api/repos/${enc(repoId)}/settings`, PutRepoSettingsResponse, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.repoSettings(repoId), data);
      void qc.invalidateQueries({ queryKey: queryKeys.repos, exact: true });
    },
  });
}

/** The returned token is shown once; it is never cached in the query client. */
export function useRotateIngestToken(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/repos/${enc(repoId)}/ingest-token/rotate`, RotateIngestTokenResponse, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.repoSettings(repoId) });
      void qc.invalidateQueries({ queryKey: queryKeys.repos, exact: true });
    },
  });
}

export function useOpenWorkflowPr(repoId: string) {
  return useMutation({
    mutationFn: (body: z.input<typeof WorkflowPrRequest>) =>
      apiFetch(`/api/repos/${enc(repoId)}/setup/workflow-pr`, WorkflowPrResponse, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

const enc = encodeURIComponent;

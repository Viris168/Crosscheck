'use client';

import { OverviewResponse } from '@app/shared/client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function useOverview(orgId: string, range: '30d' | '90d') {
  return useQuery({
    queryKey: queryKeys.overview(orgId, range),
    queryFn: () =>
      apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/overview?range=${range}`, OverviewResponse),
  });
}

'use client';

import { ListMembersResponse, UpdateMemberResponse, type MemberRole } from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export const membersKey = (orgId: string) => ['orgs', orgId, 'members'] as const;

const membersPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/members`;

export function useMembers(orgId: string) {
  return useQuery({
    queryKey: membersKey(orgId),
    queryFn: () => apiFetch(membersPath(orgId), ListMembersResponse),
  });
}

export function useUpdateMemberRole(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: MemberRole }) =>
      apiFetch(`${membersPath(orgId)}/${encodeURIComponent(memberId)}`, UpdateMemberResponse, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: membersKey(orgId) }),
  });
}

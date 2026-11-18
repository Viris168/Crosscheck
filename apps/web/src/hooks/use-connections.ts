'use client';

import { DeleteChatGptConnectionResponse, GetChatGptConnectionResponse } from '@app/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function useChatGptConnection() {
  return useQuery({
    queryKey: queryKeys.chatgptConnection,
    queryFn: () => apiFetch('/api/connections/chatgpt', GetChatGptConnectionResponse),
  });
}

export function useDisconnectChatGpt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch('/api/connections/chatgpt', DeleteChatGptConnectionResponse, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.chatgptConnection }),
  });
}

/** Full-page navigation: the OAuth flow leaves the app. */
export function chatgptConnectUrl(returnTo: string): string {
  return `/api/oauth/chatgpt/start?returnTo=${encodeURIComponent(returnTo)}`;
}

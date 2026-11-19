'use client';

import { SyncOrgsResponse } from '@app/shared/client';
import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/api-client';

export const STILL_NO_ORG =
  "Still no organization. Ask your GitHub org admin to install the app, or check that you're a member on GitHub.";

/** Re-runs the GitHub membership sync; refreshes the page when the user joined an org. */
export function CheckAgainButton() {
  const router = useRouter();
  const sync = useMutation({
    mutationFn: () => apiFetch('/api/me/sync-orgs', SyncOrgsResponse, { method: 'POST' }),
    onSuccess: (data) => {
      if (data.joined.length > 0) router.refresh();
    },
  });

  let message: string | null = null;
  if (sync.isSuccess && sync.data.joined.length === 0) message = STILL_NO_ORG;
  else if (sync.isError) {
    message =
      sync.error instanceof ApiError && sync.error.status === 429
        ? 'Too many checks. Try again in a minute.'
        : 'Could not check GitHub right now. Try again later.';
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
      >
        <RefreshCw aria-hidden className={sync.isPending ? 'animate-spin' : undefined} />
        {sync.isPending ? 'Checking…' : 'Check again'}
      </Button>
      {message && (
        <p role="status" className="max-w-sm text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}

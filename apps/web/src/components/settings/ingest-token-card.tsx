'use client';

import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { useRotateIngestToken } from '@/hooks/use-repos';

const READ_ONLY_HINT = 'You need write access to this repository on GitHub.';

/**
 * Generates / rotates the repo's ingest token. The plain token exists only in this component's
 * state after the mutation — it is shown once and never refetched.
 */
export function IngestTokenControl({
  repoId,
  hasIngestToken,
  canEdit = true,
}: {
  repoId: string;
  hasIngestToken: boolean;
  /** false disables rotation (no GitHub `write` on the repo). The server enforces it either way. */
  canEdit?: boolean;
}) {
  const rotate = useRotateIngestToken(repoId);
  const [token, setToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = () =>
    rotate.mutate(undefined, {
      onSuccess: (r) => {
        setToken(r.token);
        setConfirming(false);
      },
    });

  return (
    <div className="flex flex-col gap-3">
      {token ? (
        <Alert tone="warning">
          <KeyRound aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p>
              Copy this token into the <code>PLATFORM_INGEST_TOKEN</code> secret now. It won&apos;t
              be shown again.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code
                className="min-w-0 flex-1 break-all rounded bg-white/70 px-2 py-1"
                data-testid="ingest-token"
              >
                {token}
              </code>
              <CopyButton value={token} />
            </div>
          </div>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          {hasIngestToken
            ? 'An ingest token is configured. Rotating it stops the old token from working.'
            : 'No ingest token yet. Generate one for your GitHub Action.'}
        </p>
      )}

      {hasIngestToken && !token && confirming ? (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Confirm rotation"
        >
          <span className="text-sm">The current token will stop working. Continue?</span>
          <Button variant="destructive" size="sm" onClick={run} disabled={rotate.isPending}>
            Rotate token
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
            Keep current token
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1">
          <span title={canEdit ? undefined : READ_ONLY_HINT}>
            <Button
              variant={hasIngestToken || token ? 'outline' : 'default'}
              size="sm"
              disabled={!canEdit || rotate.isPending}
              onClick={() => (hasIngestToken && !token ? setConfirming(true) : run())}
            >
              {hasIngestToken || token ? 'Rotate token' : 'Generate token'}
            </Button>
          </span>
          {!canEdit && (
            <p role="note" className="text-xs text-muted-foreground">
              {READ_ONLY_HINT}
            </p>
          )}
        </div>
      )}
      {rotate.error && <Alert tone="error">{rotate.error.message}</Alert>}
    </div>
  );
}

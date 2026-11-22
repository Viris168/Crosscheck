'use client';

import { isActionProvider, type RepoListItem } from '@app/shared/client';
import { GitBranch, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { ProviderBadge, StaleBadge, StatusChip } from '@/components/chips';
import { InstallAppButton } from '@/components/install-app-button';
import { QueryError } from '@/components/query-error';
import { buttonVariants } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/skeleton';
import { useRepos } from '@/hooks/use-repos';

/** Action providers need the ingest token (and workflow) before they can deliver results. */
export function needsSetup(repo: Pick<RepoListItem, 'provider' | 'hasIngestToken'>): boolean {
  return isActionProvider(repo.provider) && !repo.hasIngestToken;
}

/**
 * `installUrl`: GitHub's install page for our App (null when unknown).
 * `canManage`: the viewer is an org owner/admin. Members only see the repos they are a GitHub
 * collaborator on, so an empty list means "no access yet", not "nothing installed".
 */
export function RepoList({
  installUrl = null,
  canManage = true,
}: {
  installUrl?: string | null;
  canManage?: boolean;
}) {
  const { data, error, isPending } = useRepos();
  if (isPending) return <LoadingState label="Loading repositories…" />;
  if (error) return <QueryError error={error} what="organization" />;
  if (data.length === 0 && !canManage) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">
          You don&apos;t have access to any repositories here yet.
        </p>
        <p>
          You see the repositories you&apos;re a collaborator on in GitHub. Ask an owner of this
          organization to add you.
        </p>
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        No repositories yet. Install the GitHub App on your organization to add repositories.
        <InstallAppButton href={installUrl} />
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {data.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
          <Link
            href={`/repos/${r.id}/pulls`}
            className="flex-1 truncate rounded font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {r.fullName}
          </Link>
          <span className="flex flex-wrap items-center gap-2">
            <ProviderBadge provider={r.provider} />
            {!r.active && <span className="text-xs text-muted-foreground">Paused</span>}
            {r.lastReview ? (
              <>
                <span className="text-xs text-muted-foreground">Last review:</span>
                <StatusChip status={r.lastReview.status} />
                {r.lastReview.stale && <StaleBadge />}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">No reviews yet</span>
            )}
            <Link
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
              href={`/repos/${r.id}/tree`}
              aria-label={`Branches of ${r.fullName}`}
            >
              <GitBranch aria-hidden /> Branches
            </Link>
            {needsSetup(r) ? (
              <Link className={buttonVariants({ size: 'sm' })} href={`/repos/${r.id}/setup`}>
                Set up
              </Link>
            ) : (
              <Link
                className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                href={`/repos/${r.id}/settings`}
                aria-label={`Settings for ${r.fullName}`}
              >
                <Settings2 aria-hidden />
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

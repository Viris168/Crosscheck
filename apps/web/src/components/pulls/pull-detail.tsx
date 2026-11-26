'use client';

import type { GetPullResponse } from '@app/shared/client';
import type { z } from 'zod';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DiffStat, ProviderBadge, StaleBadge, StatusChip } from '@/components/chips';
import { ChangedFiles } from '@/components/files/changed-files';
import { MergeControl } from '@/components/pulls/merge-control';
import { ReviewPanel } from '@/components/review/review-panel';
import { QueryError } from '@/components/query-error';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { LinkTabs } from '@/components/ui/link-tabs';
import { LoadingState } from '@/components/ui/skeleton';
import { usePull } from '@/hooks/use-pulls';
import { useRerunReview, useReview } from '@/hooks/use-reviews';
import { shortSha } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function PullDetail({ repoId, number }: { repoId: string; number: number }) {
  const { data, error, isPending } = usePull(repoId, number);
  if (isPending) return <LoadingState label="Loading pull request…" />;
  if (error) return <QueryError error={error} what="pull request" />;
  return <PullDetailView data={data} repoId={repoId} />;
}

type PullDetailData = z.infer<typeof GetPullResponse>;

function PullDetailView({ data, repoId }: { data: PullDetailData; repoId: string }) {
  const { pull, files, reviews } = data;
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tab = params.get('tab') === 'files' ? 'files' : 'reviews';
  const selectedId = params.get('review') ?? data.review?.id ?? null;

  // The latest review comes with the PR; older ones are fetched (and polled) by id.
  const isLatest = selectedId === data.review?.id;
  const selected = useReview(isLatest ? null : selectedId);
  const review = isLatest ? data.review : selected.data;

  const setReview = (id: string) => {
    const q = new URLSearchParams(params);
    q.set('review', id);
    q.delete('tab');
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const tabHref = (t: 'reviews' | 'files') => {
    const q = new URLSearchParams(params);
    if (t === 'files') q.set('tab', 'files');
    else q.delete('tab');
    q.delete('file');
    q.delete('line');
    const s = q.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  // PRs first seen by the branch-tree sync come from GitHub's list call, which has no
  // diff stats; until a pull_request webhook fills them in, count the changed files.
  const stats =
    pull.changedFiles === 0 && files.length > 0
      ? {
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
          changedFiles: files.length,
        }
      : pull;

  const focusFile = params.get('file');
  const focusLine = Number(params.get('line')) || undefined;
  const ctx = {
    repoId,
    repoFullName: pull.repoFullName,
    prNumber: pull.number,
    prPath: pathname,
    headRef: pull.headRef,
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          <Link className="hover:underline" href={`/repos/${repoId}/pulls`}>
            {pull.repoFullName}
          </Link>{' '}
          · #{pull.number} · {pull.author} · {pull.state}
        </p>
        <h1 className="flex items-start gap-2 text-2xl font-semibold">
          <GitPullRequest aria-hidden className="mt-1.5 size-5 shrink-0" />
          {pull.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-mono">
            {pull.headRef} → {pull.baseRef}
          </span>
          <DiffStat additions={stats.additions} deletions={stats.deletions} />
          <span className="text-muted-foreground">{stats.changedFiles} files</span>
          <a
            href={pull.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-auto')}
          >
            Open on GitHub <ExternalLink aria-hidden />
          </a>
          {pull.state === 'open' && (
            <MergeControl
              repoId={repoId}
              number={pull.number}
              review={data.review}
              reviews={reviews}
            />
          )}
        </div>
      </header>

      <LinkTabs
        label="Pull request sections"
        tabs={[
          {
            href: tabHref('reviews'),
            label: 'Reviews',
            active: tab === 'reviews',
            count: reviews.length,
          },
          {
            href: tabHref('files'),
            label: 'Changed Files',
            active: tab === 'files',
            count: files.length,
          },
        ]}
      />

      {tab === 'files' ? (
        <ChangedFiles
          files={files}
          issues={review?.issues ?? []}
          focus={focusFile ? { file: focusFile, line: focusLine } : null}
          target={ctx}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
          <div className="min-w-0">
            {review ? (
              <ReviewPanel review={review} ctx={ctx} onStarted={setReview} />
            ) : selected.isPending && selectedId ? (
              <LoadingState label="Loading review…" />
            ) : selected.error ? (
              <QueryError error={selected.error} what="review" />
            ) : (
              <NoReview repoId={repoId} number={pull.number} />
            )}
          </div>
          {reviews.length > 0 && (
            <aside aria-labelledby="history-heading" className="flex flex-col gap-2">
              <h2 id="history-heading" className="text-sm font-semibold">
                Review history
              </h2>
              <ul className="flex flex-col gap-1">
                {reviews.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setReview(r.id)}
                      aria-current={r.id === selectedId ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 rounded-md border px-3 py-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        r.id === selectedId && 'border-foreground',
                      )}
                    >
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusChip status={r.status} />
                        {r.stale && <StaleBadge />}
                      </span>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <ProviderBadge provider={r.provider} />
                        <code>{shortSha(r.headSha)}</code>
                      </span>
                      <time dateTime={r.createdAt} className="text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function NoReview({ repoId, number }: { repoId: string; number: number }) {
  const rerun = useRerunReview(repoId, number);
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
      <p className="text-sm text-muted-foreground">This pull request has not been reviewed yet.</p>
      <Button onClick={() => rerun.mutate(undefined)} disabled={rerun.isPending}>
        Review now
      </Button>
      {rerun.error && <Alert tone="error">{rerun.error.message}</Alert>}
    </div>
  );
}

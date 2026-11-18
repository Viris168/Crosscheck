'use client';

import { isActionProvider, type ProviderId } from '@app/shared/client';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { StatusChip } from '@/components/chips';
import { ChatGptConnectionCard } from '@/components/connections/chatgpt-connection';
import { QueryError } from '@/components/query-error';
import { IngestTokenControl } from '@/components/settings/ingest-token-card';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/skeleton';
import { usePulls } from '@/hooks/use-pulls';
import { useOpenWorkflowPr, useRepoSettings, useUpdateRepoSettings } from '@/hooks/use-repos';
import { useRerunReview, useReview } from '@/hooks/use-reviews';
import { cn } from '@/lib/utils';

const CHOICES: { id: ProviderId; title: string; body: string }[] = [
  {
    id: 'claude_action',
    title: 'Claude (my plan)',
    body: 'Runs Claude Code in your GitHub Action with your Claude subscription.',
  },
  {
    id: 'codex_chatgpt',
    title: 'Codex (my ChatGPT plan)',
    body: 'We run Codex for you after you sign in with ChatGPT.',
  },
  {
    id: 'codex_action',
    title: 'Codex (my OpenAI key)',
    body: 'Runs Codex in your GitHub Action with your OpenAI API key.',
  },
  { id: 'platform', title: 'Platform default', body: 'We review with our default model.' },
];

export function SetupWizard({ repoId, repoFullName }: { repoId: string; repoFullName: string }) {
  const settings = useRepoSettings(repoId);
  const update = useUpdateRepoSettings(repoId);
  if (settings.isPending) return <LoadingState label="Loading setup…" />;
  if (settings.error) return <QueryError error={settings.error} what="repository" />;
  const { provider, hasIngestToken } = settings.data;

  return (
    <ol className="flex flex-col gap-6">
      <Step n={1} title="Install the GitHub App" done>
        <p className="text-sm text-muted-foreground">
          The app is installed on <strong>{repoFullName}</strong>.{' '}
          <a
            className="underline underline-offset-2"
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noreferrer"
          >
            Manage installations
          </a>
        </p>
      </Step>

      <Step n={2} title="Choose the AI reviewer">
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={update.isPending}>
          <legend className="sr-only">Reviewer</legend>
          {CHOICES.map((c) => (
            <label
              key={c.id}
              className={cn(
                'flex cursor-pointer gap-3 rounded-xl border p-4 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                provider === c.id && 'border-foreground bg-accent',
              )}
            >
              <input
                type="radio"
                name="provider"
                value={c.id}
                checked={provider === c.id}
                onChange={() => update.mutate({ provider: c.id, settings: settings.data.settings })}
                className="mt-1"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{c.title}</span>
                <span className="text-sm text-muted-foreground">{c.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {update.error && <Alert tone="error">{update.error.message}</Alert>}
      </Step>

      <Step n={3} title="Connect it">
        <ProviderSteps repoId={repoId} provider={provider} hasIngestToken={hasIngestToken} />
      </Step>

      <Step n={4} title="Test the connection">
        <TestConnection repoId={repoId} />
      </Step>
    </ol>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
          done && 'border-green-600 bg-green-50 text-green-800',
        )}
      >
        {done ? <CheckCircle2 className="size-4" /> : n}
      </span>
      <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label={`Step ${n}: ${title}`}>
        <h2 className="font-semibold">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h2>
        {children}
      </section>
    </li>
  );
}

function ProviderSteps({
  repoId,
  provider,
  hasIngestToken,
}: {
  repoId: string;
  provider: ProviderId;
  hasIngestToken: boolean;
}) {
  if (provider === 'platform') {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to do — reviews start on the next push.
      </p>
    );
  }
  if (provider === 'codex_chatgpt') {
    return <ChatGptConnectionCard returnTo={`/repos/${repoId}/setup`} />;
  }
  return <ActionSteps repoId={repoId} provider={provider} hasIngestToken={hasIngestToken} />;
}

/** Claude / Codex in the user's own GitHub Action. Secrets go to GitHub only — never to us. */
function ActionSteps({
  repoId,
  provider,
  hasIngestToken,
}: {
  repoId: string;
  provider: ProviderId;
  hasIngestToken: boolean;
}) {
  const workflowPr = useOpenWorkflowPr(repoId);
  const claude = provider === 'claude_action';
  const keySecret = claude ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'OPENAI_API_KEY';
  if (!isActionProvider(provider)) return null;

  return (
    <div className="flex flex-col gap-4 text-sm">
      {claude ? (
        <p>
          On your computer, run{' '}
          <code className="rounded bg-secondary px-1">claude setup-token</code> and copy the token
          it prints. You will paste it into a GitHub secret — never into this site.
        </p>
      ) : (
        <p>
          Create an OpenAI API key for reviews. You will paste it into a GitHub secret — never into
          this site.
        </p>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="font-medium">Ingest token</h3>
        <IngestTokenControl repoId={repoId} hasIngestToken={hasIngestToken} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-medium">Add these repository secrets on GitHub</h3>
        <ul className="list-inside list-disc">
          <li>
            <code>{keySecret}</code> —{' '}
            {claude ? 'the token from `claude setup-token`' : 'your OpenAI API key'}
          </li>
          <li>
            <code>PLATFORM_INGEST_TOKEN</code> — the ingest token above
          </li>
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() =>
            workflowPr.mutate({ provider: provider as 'claude_action' | 'codex_action' })
          }
          disabled={workflowPr.isPending}
        >
          {workflowPr.isPending ? 'Opening PR…' : 'Commit workflow'}
        </Button>
        {workflowPr.data && (
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={workflowPr.data.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open PR #{workflowPr.data.prNumber} <ExternalLink aria-hidden />
          </a>
        )}
      </div>
      {workflowPr.error && <Alert tone="error">{workflowPr.error.message}</Alert>}
    </div>
  );
}

function TestConnection({ repoId }: { repoId: string }) {
  const pulls = usePulls(repoId, 'open');
  const latest = pulls.data?.[0];
  const rerun = useRerunReview(repoId, latest?.number ?? 0);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const review = useReview(reviewId);

  if (pulls.isPending) return <LoadingState label="Loading pull requests…" />;
  if (!latest) {
    return (
      <p className="text-sm text-muted-foreground">
        Open a pull request in this repository, then come back to test.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Re-run a review on the latest open PR:{' '}
        <Link className="underline" href={`/repos/${repoId}/pulls/${latest.number}`}>
          #{latest.number} {latest.title}
        </Link>
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={rerun.isPending}
          onClick={() => rerun.mutate(undefined, { onSuccess: (r) => setReviewId(r.reviewId) })}
        >
          Test connection
        </Button>
        {review.data && (
          <span className="flex items-center gap-2" role="status" aria-live="polite">
            <StatusChip status={review.data.status} />
            <Link
              className="underline"
              href={`/repos/${repoId}/pulls/${latest.number}?review=${review.data.id}`}
            >
              View review
            </Link>
          </span>
        )}
      </div>
      {rerun.error && <Alert tone="error">{rerun.error.message}</Alert>}
    </div>
  );
}

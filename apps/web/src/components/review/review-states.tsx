'use client';

import { ProviderId, type ReviewDetail, type ReviewIssueWithId } from '@app/shared/client';
import { AlertTriangle, CheckCircle2, Circle, Clock, ExternalLink, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ProviderBadge, RiskBadge, SeverityBadge } from '@/components/chips';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { filesTabHref } from '@/lib/diff';
import { formatDuration, PROVIDER_LABEL, shortSha } from '@/lib/labels';
import { useNow } from '@/lib/use-now';
import { failureMessage } from './failure-message';

export interface ReviewContext {
  repoId: string;
  repoFullName: string;
  prNumber: number;
  /** Base path of the PR page, used for "jump to line" links. */
  prPath: string;
}

export interface ReviewActions {
  onRetry: () => void;
  onRerun: (provider?: ProviderId) => void;
  pending: boolean;
}

interface StateProps {
  review: ReviewDetail;
  ctx: ReviewContext;
}

// ---------------------------------------------------------------- queued

export function ReviewQueued({ review }: StateProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock aria-hidden className="size-4" /> Waiting to start
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
        Provider: <ProviderBadge provider={review.provider} />
      </CardContent>
      <CardFooter>
        {/* Pending contract: POST /api/reviews/:id/cancel (tasks/CONTRACT_REQUESTS.md). */}
        <Button variant="outline" disabled aria-describedby={`cancel-note-${review.id}`}>
          Cancel
        </Button>
        <span id={`cancel-note-${review.id}`} className="text-xs text-muted-foreground">
          Cancelling a queued review isn&apos;t available yet.
        </span>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------- running

export function ReviewRunning({ review }: StateProps) {
  const now = useNow();
  const elapsed = formatDuration(now - new Date(review.createdAt).getTime());
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Reviewed {review.filesDone} of {review.filesTotal} files
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Progress
          value={review.filesDone}
          max={review.filesTotal}
          label={`Reviewed ${review.filesDone} of ${review.filesTotal} files`}
        />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ProviderBadge provider={review.provider} />
          <span>
            Elapsed: <span className="tabular-nums">{elapsed}</span>
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- waiting_action

export function ReviewWaitingAction({ review, ctx }: StateProps) {
  const keySecret =
    review.provider === 'codex_action' ? 'OPENAI_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  const items = [
    <>
      Workflow file in <code>.github/workflows/</code>
    </>,
    <>
      Repository secret <code>{keySecret}</code>
    </>,
    <>
      Repository secret <code>PLATFORM_INGEST_TOKEN</code>
    </>,
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting for your GitHub Action</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {PROVIDER_LABEL[review.provider]} runs in your repository. Check that it is set up:
        </p>
        <ul className="flex flex-col gap-2" aria-label="Setup checklist">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2">
              <Circle aria-hidden className="size-4 text-muted-foreground" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Link className={buttonVariants()} href={`/repos/${ctx.repoId}/setup`}>
          Open setup
        </Link>
        <a
          className={buttonVariants({ variant: 'outline' })}
          href={`https://github.com/${ctx.repoFullName}/actions`}
          target="_blank"
          rel="noreferrer"
        >
          Open Actions tab <ExternalLink aria-hidden />
        </a>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------- completed

export function ReviewCompleted({ review, ctx, actions }: StateProps & { actions: ReviewActions }) {
  const byFile = groupByFile(review.issues);
  return (
    <div className="flex flex-col gap-4">
      {review.stale && (
        <Alert tone="warning">
          <AlertTriangle aria-hidden />
          <div>
            <strong>Stale review.</strong> The PR has new commits since this review (reviewed{' '}
            <code>{shortSha(review.headSha)}</code>). Re-run to review the latest changes.
          </div>
        </Alert>
      )}
      {review.errorCode === 'too_large' && <Alert tone="info">{failureMessage(review, ctx)}</Alert>}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 aria-hidden className="size-4 text-green-700" /> Review completed
          </CardTitle>
          <ProviderBadge provider={review.provider} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {review.risk ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="text-3xl font-semibold tabular-nums" aria-label="Risk score">
                  {review.risk.score}
                </span>
                <RiskBadge level={review.risk.level} />
              </div>
              {review.risk.factors.length > 0 && (
                <ul className="flex flex-col gap-1 text-sm" aria-label="Risk factors">
                  {review.risk.factors.map((f) => (
                    <li key={f.key} className="flex justify-between gap-4">
                      <span>{f.label}</span>
                      <span className="tabular-nums text-muted-foreground">+{f.points}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No risk score.</p>
          )}
          {review.summary && <p className="text-sm whitespace-pre-line">{review.summary}</p>}
        </CardContent>
        <CardFooter>
          <Button onClick={() => actions.onRerun()} disabled={actions.pending}>
            <RotateCw aria-hidden /> Re-run
          </Button>
          <RerunWithOther current={review.provider} actions={actions} />
        </CardFooter>
      </Card>

      <section aria-labelledby="issues-heading" className="flex flex-col gap-3">
        <h3 id="issues-heading" className="text-sm font-semibold">
          Issues ({review.issues.length})
        </h3>
        {review.issues.length === 0 && (
          <p className="text-sm text-muted-foreground">No issues found.</p>
        )}
        {byFile.map(([file, issues]) => (
          <Card key={file}>
            <CardHeader className="pb-1">
              <h4 className="font-mono text-sm">{file}</h4>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {issues.map((issue) => (
                  <li key={issue.id} className="py-2 first:pt-0 last:pb-0">
                    <Link
                      href={filesTabHref(ctx.prPath, issue.file, issue.line, review.id)}
                      scroll={false}
                      className="flex flex-col gap-1 rounded-md p-1 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={issue.severity} />
                        <span className="text-xs text-muted-foreground">{issue.category}</span>
                        <span className="font-medium">{issue.title}</span>
                        <span className="ml-auto font-mono text-xs text-muted-foreground">
                          line {issue.line}
                        </span>
                      </span>
                      <span className="text-sm text-muted-foreground">{issue.explanation}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

function groupByFile(issues: ReviewIssueWithId[]): [string, ReviewIssueWithId[]][] {
  const map = new Map<string, ReviewIssueWithId[]>();
  for (const i of issues) map.set(i.file, [...(map.get(i.file) ?? []), i]);
  return [...map];
}

function RerunWithOther({
  current,
  actions,
  label = 'Re-run with',
}: {
  current: ProviderId;
  actions: ReviewActions;
  label?: string;
}) {
  const others = ProviderId.filter((p) => p !== current);
  const [provider, setProvider] = useState<ProviderId>(others[0]!);
  const id = `rerun-provider-${current}`;
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="sr-only">
        Other provider
      </Label>
      <Select
        id={id}
        value={provider}
        onChange={(e) => setProvider(e.target.value as ProviderId)}
        className="w-auto"
      >
        {others.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABEL[p]}
          </option>
        ))}
      </Select>
      <Button
        variant="outline"
        onClick={() => actions.onRerun(provider)}
        disabled={actions.pending}
      >
        {label}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- failed

export function ReviewFailed({ review, ctx, actions }: StateProps & { actions: ReviewActions }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review failed</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Alert tone="error">
          <AlertTriangle aria-hidden />
          <div data-testid="failure-message">{failureMessage(review, ctx)}</div>
        </Alert>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          Provider: <ProviderBadge provider={review.provider} />
        </p>
      </CardContent>
      <CardFooter>
        <Button onClick={actions.onRetry} disabled={actions.pending}>
          <RotateCw aria-hidden /> Retry
        </Button>
        <Link
          className={buttonVariants({ variant: 'outline' })}
          href={`/repos/${ctx.repoId}/settings`}
        >
          Change provider
        </Link>
        <RerunWithOther current={review.provider} actions={actions} label="Run with" />
      </CardFooter>
    </Card>
  );
}

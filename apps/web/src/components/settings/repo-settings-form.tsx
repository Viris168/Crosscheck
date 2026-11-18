'use client';

import {
  ProviderId,
  Severity,
  type GetRepoSettingsResponse,
  type RepoSettings,
} from '@app/shared/client';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { z } from 'zod';
import { QueryError } from '@/components/query-error';
import { IngestTokenControl } from '@/components/settings/ingest-token-card';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/skeleton';
import { useRepoSettings, useUpdateRepoSettings } from '@/hooks/use-repos';
import { PROVIDER_LABEL, SEVERITY_LABEL } from '@/lib/labels';

type Settings = z.infer<typeof GetRepoSettingsResponse>;

export function RepoSettingsPage({ repoId }: { repoId: string }) {
  const { data, error, isPending } = useRepoSettings(repoId);
  if (isPending) return <LoadingState label="Loading settings…" />;
  if (error) return <QueryError error={error} what="repository" />;
  return (
    <div className="flex flex-col gap-6">
      <RepoSettingsForm key={JSON.stringify(data)} repoId={repoId} initial={data} />
      <Card className="border-red-200">
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            The ingest token lets your GitHub Action send results. Rotate it if it may have leaked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <IngestTokenControl repoId={repoId} hasIngestToken={data.hasIngestToken} />
        </CardContent>
      </Card>
    </div>
  );
}

function RepoSettingsForm({ repoId, initial }: { repoId: string; initial: Settings }) {
  const update = useUpdateRepoSettings(repoId);
  const [provider, setProvider] = useState<ProviderId>(initial.provider);
  const [s, setS] = useState<RepoSettings>(initial.settings);
  const [ignore, setIgnore] = useState(initial.settings.ignorePaths.join('\n'));
  const set = <K extends keyof RepoSettings>(k: K, v: RepoSettings[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { model, ...rest } = s;
    update.mutate({
      provider,
      settings: {
        ...rest,
        ...(model?.trim() ? { model: model.trim() } : {}),
        ignorePaths: ignore
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      },
    });
  };

  return (
    <Card>
      <form onSubmit={submit} aria-label="Review settings">
        <CardHeader>
          <CardTitle>Reviewer</CardTitle>
          <CardDescription>Which AI reviews this repository, and how.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="provider" label="Provider" className="sm:col-span-2">
            <Select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
            >
              {ProviderId.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </Select>
            {provider !== initial.provider && (
              <p className="text-xs text-muted-foreground">
                After saving, finish the steps in{' '}
                <Link className="underline" href={`/repos/${repoId}/setup`}>
                  setup
                </Link>
                .
              </p>
            )}
          </Field>
          <Field id="model" label="Model (optional)">
            <Input
              id="model"
              value={s.model ?? ''}
              placeholder="Provider default"
              onChange={(e) => set('model', e.target.value)}
            />
          </Field>
          <Field id="minSeverity" label="Minimum severity to comment">
            <Select
              id="minSeverity"
              value={s.minSeverity}
              onChange={(e) => set('minSeverity', e.target.value as Severity)}
            >
              {Severity.map((v) => (
                <option key={v} value={v}>
                  {SEVERITY_LABEL[v]}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="maxIssuesPerPr" label="Max issues per PR">
            <Input
              id="maxIssuesPerPr"
              type="number"
              min={1}
              max={200}
              required
              value={s.maxIssuesPerPr}
              onChange={(e) => set('maxIssuesPerPr', Number.parseInt(e.target.value, 10) || 1)}
            />
          </Field>
          <Field id="language" label="Comment language">
            <Input
              id="language"
              value={s.language}
              required
              onChange={(e) => set('language', e.target.value)}
            />
          </Field>
          <Field id="trigger" label="Trigger">
            <Select
              id="trigger"
              value={s.trigger}
              onChange={(e) => set('trigger', e.target.value as RepoSettings['trigger'])}
            >
              <option value="every_push">Every push</option>
              <option value="on_command">On command only</option>
            </Select>
          </Field>
          <Field
            id="ignorePaths"
            label="Ignore paths (one glob per line)"
            className="sm:col-span-2"
          >
            <Textarea id="ignorePaths" value={ignore} onChange={(e) => setIgnore(e.target.value)} />
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          <Link className={buttonVariants({ variant: 'ghost' })} href={`/repos/${repoId}/setup`}>
            Setup guide
          </Link>
          {update.isSuccess && (
            <span role="status" className="text-sm text-green-700">
              Saved.
            </span>
          )}
          {update.error && (
            <Alert tone="error" className="w-full">
              {update.error.message}
            </Alert>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}

function Field({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

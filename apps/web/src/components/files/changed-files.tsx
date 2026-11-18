'use client';

import type { ChangedFileSchema, ReviewIssueWithId } from '@app/shared/client';
import { FileCode2, Folder } from 'lucide-react';
import { Fragment, useEffect, useMemo } from 'react';
import type { z } from 'zod';
import { DiffStat, SeverityBadge } from '@/components/chips';
import { Card } from '@/components/ui/card';
import { fileAnchor, lineAnchor, parsePatch } from '@/lib/diff';
import { cn } from '@/lib/utils';

type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** File tree + unified diff, with inline markers on lines that have findings. */
export function ChangedFiles({
  files,
  issues,
  focus,
}: {
  files: ChangedFile[];
  issues: ReviewIssueWithId[];
  focus?: { file: string; line?: number } | null;
}) {
  const issuesByFile = useMemo(() => {
    const m = new Map<string, Map<number, ReviewIssueWithId[]>>();
    for (const i of issues) {
      const lines = m.get(i.file) ?? new Map<number, ReviewIssueWithId[]>();
      lines.set(i.line, [...(lines.get(i.line) ?? []), i]);
      m.set(i.file, lines);
    }
    return m;
  }, [issues]);

  // Jump to ?file=&line= once the diff is rendered.
  useEffect(() => {
    if (!focus) return;
    const id = focus.line != null ? lineAnchor(focus.file, focus.line) : fileAnchor(focus.file);
    const el = document.getElementById(id) ?? document.getElementById(fileAnchor(focus.file));
    el?.scrollIntoView?.({ block: 'center' });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  }, [focus]);

  if (files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Changed files are not available for this pull request right now.
      </p>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <FileTree files={files} issuesByFile={issuesByFile} />
      <div className="flex min-w-0 flex-col gap-4">
        {files.map((f) => (
          <FileDiff
            key={f.path}
            file={f}
            issues={issuesByFile.get(f.path)}
            focusLine={focus?.file === f.path ? focus.line : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function FileTree({
  files,
  issuesByFile,
}: {
  files: ChangedFile[];
  issuesByFile: Map<string, Map<number, ReviewIssueWithId[]>>;
}) {
  const dirs = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const dir = i === -1 ? '' : f.path.slice(0, i);
    dirs.set(dir, [...(dirs.get(dir) ?? []), f]);
  }
  return (
    <nav aria-label="Changed files" className="text-sm lg:sticky lg:top-4 lg:self-start">
      <ul className="flex flex-col gap-2">
        {[...dirs]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([dir, fs]) => (
            <li key={dir}>
              {dir && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Folder aria-hidden className="size-3.5" /> {dir}/
                </span>
              )}
              <ul className={cn('flex flex-col', dir && 'ml-4')}>
                {fs.map((f) => {
                  const count = [...(issuesByFile.get(f.path)?.values() ?? [])].flat().length;
                  return (
                    <li key={f.path}>
                      <a
                        href={`#${fileAnchor(f.path)}`}
                        className="flex items-center gap-1 rounded px-1 py-0.5 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <FileCode2 aria-hidden className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {f.path.slice(f.path.lastIndexOf('/') + 1)}
                        </span>
                        {count > 0 && (
                          <span className="ml-auto rounded-full bg-red-100 px-1.5 text-xs text-red-800">
                            {count}
                            <span className="sr-only"> issues</span>
                          </span>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
      </ul>
    </nav>
  );
}

const ROW_TONE = {
  add: 'bg-green-50',
  del: 'bg-red-50',
  context: '',
  hunk: 'bg-blue-50 text-blue-900',
  meta: 'text-muted-foreground',
} as const;
const SIGN = { add: '+', del: '−', context: ' ', hunk: '', meta: '' } as const;

function FileDiff({
  file,
  issues,
  focusLine,
}: {
  file: ChangedFile;
  issues?: Map<number, ReviewIssueWithId[]>;
  focusLine?: number;
}) {
  const lines = file.patch ? parsePatch(file.patch) : [];
  return (
    <Card id={fileAnchor(file.path)} tabIndex={-1} className="min-w-0 overflow-hidden outline-none">
      <header className="flex flex-wrap items-center gap-2 border-b bg-secondary/50 px-4 py-2">
        <h3 className="font-mono text-sm break-all">
          {file.previousPath && file.previousPath !== file.path && (
            <span className="text-muted-foreground">{file.previousPath} → </span>
          )}
          {file.path}
        </h3>
        <span className="text-xs text-muted-foreground">{file.status}</span>
        <span className="ml-auto">
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </span>
      </header>
      {lines.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No diff to show (binary or very large file).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs">
            <caption className="sr-only">Diff of {file.path}</caption>
            <tbody>
              {lines.map((l, idx) => {
                const found = l.newLine != null ? issues?.get(l.newLine) : undefined;
                const anchor = l.newLine != null ? lineAnchor(file.path, l.newLine) : undefined;
                return (
                  <Fragment key={idx}>
                    <tr
                      id={anchor}
                      tabIndex={anchor ? -1 : undefined}
                      data-has-issue={found ? 'true' : undefined}
                      className={cn(
                        ROW_TONE[l.kind],
                        'outline-none',
                        found && 'border-l-4 border-l-red-500',
                        focusLine != null &&
                          l.newLine === focusLine &&
                          'ring-2 ring-inset ring-amber-400',
                      )}
                    >
                      <td className="w-10 select-none px-2 text-right text-muted-foreground">
                        {l.oldLine ?? ''}
                      </td>
                      <td className="w-10 select-none px-2 text-right text-muted-foreground">
                        {l.newLine ?? ''}
                      </td>
                      <td className="w-4 select-none text-center" aria-hidden>
                        {SIGN[l.kind]}
                      </td>
                      <td className="whitespace-pre px-2">
                        {l.kind === 'add' && <span className="sr-only">added: </span>}
                        {l.kind === 'del' && <span className="sr-only">removed: </span>}
                        {l.text}
                      </td>
                    </tr>
                    {found && (
                      <tr>
                        <td colSpan={4} className="border-y bg-amber-50 px-4 py-2 font-sans">
                          <ul
                            className="flex flex-col gap-1"
                            aria-label={`Issues on line ${l.newLine}`}
                          >
                            {found.map((i) => (
                              <li key={i.id} className="flex flex-col gap-0.5 text-sm">
                                <span className="flex items-center gap-2">
                                  <SeverityBadge severity={i.severity} />
                                  <span className="font-medium">{i.title}</span>
                                </span>
                                <span className="text-muted-foreground">{i.explanation}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

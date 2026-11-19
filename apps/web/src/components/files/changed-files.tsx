'use client';

import type { ChangedFileSchema, ReviewIssueWithId, Severity } from '@app/shared/client';
import { FileCode2, Folder } from 'lucide-react';
import { Fragment, useEffect, useMemo } from 'react';
import type { z } from 'zod';
import { DiffStat, SeverityBadge } from '@/components/chips';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { changedRanges, fileAnchor, lineAnchor, parsePatch, type DiffLine } from '@/lib/diff';
import { issueFixPrompt, type FixTarget } from '@/lib/fix-prompt';
import { highlightLine, languageFor, markRange } from '@/lib/highlight';
import { cn } from '@/lib/utils';

type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** File tree + unified diff, with inline markers on lines that have findings. */
export function ChangedFiles({
  files,
  issues,
  focus,
  target,
}: {
  files: ChangedFile[];
  issues: ReviewIssueWithId[];
  focus?: { file: string; line?: number } | null;
  /** The PR, for "Copy for Claude" prompts on findings; no button without it. */
  target?: FixTarget;
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
            target={target}
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

/** Row / side-bar classes per line kind; colours live in globals.css (`.diff-dark`). */
const ROW = {
  add: 'diff-row-add',
  del: 'diff-row-del',
  context: '',
  hunk: 'diff-row-hunk',
  meta: 'diff-row-meta',
} as const;
const BAR = { add: 'diff-bar-add', del: 'diff-bar-del', context: '', hunk: '', meta: '' } as const;

/** One diff line: syntax-highlighted, with the changed characters of a paired edit marked. */
function Code({
  line,
  language,
  range,
}: {
  line: DiffLine;
  language?: string;
  range?: [number, number];
}) {
  if (line.kind === 'hunk' || line.kind === 'meta') return <>{line.text}</>;
  const segments = highlightLine(line.text, language);
  return (
    <>
      {(range ? markRange(segments, range) : segments).map((seg, i) => (
        <span key={i} className={cn(seg.cls, seg.mark && 'diff-word')}>
          {seg.text}
        </span>
      ))}
    </>
  );
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The most severe level among a line's findings; it sets the line's bar and note colour. */
function worst(issues: ReviewIssueWithId[]): Severity {
  return issues.reduce<Severity>(
    (w, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w),
    'low',
  );
}

/** One finding under a diff line: glass severity + category, title, explanation, suggested fix. */
function IssueNote({ issue, target }: { issue: ReviewIssueWithId; target?: FixTarget }) {
  return (
    <li className="flex flex-col gap-2 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={issue.severity} glass />
        <span className="glass-chip">{issue.category}</span>
        <span className="diff-issue-title">{issue.title}</span>
        {target && (
          <CopyButton
            value={issueFixPrompt(target, issue)}
            label="Copy for Claude"
            title={`Copy a prompt to fix "${issue.title}" in Claude Code`}
            className="glass-button ml-auto"
          />
        )}
      </div>
      <p className="diff-issue-text max-w-[80ch]">{issue.explanation}</p>
      {issue.suggested_fix && (
        <details className="diff-issue-fix">
          <summary>Suggested fix</summary>
          <pre>{issue.suggested_fix}</pre>
        </details>
      )}
    </li>
  );
}

function FileDiff({
  file,
  issues,
  focusLine,
  target,
}: {
  file: ChangedFile;
  issues?: Map<number, ReviewIssueWithId[]>;
  focusLine?: number;
  target?: FixTarget;
}) {
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const ranges = useMemo(() => changedRanges(lines), [lines]);
  const language = languageFor(file.path);
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
        <div className="diff-dark overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[13px] leading-6">
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
                        ROW[l.kind],
                        'outline-none',
                        focusLine != null && l.newLine === focusLine && 'diff-row-focus',
                      )}
                    >
                      <td
                        className={cn('w-1 p-0', found ? `diff-bar-${worst(found)}` : BAR[l.kind])}
                      />
                      <td className="diff-line-no w-12 select-none pr-4 pl-3 text-right">
                        {l.newLine ?? l.oldLine ?? ''}
                      </td>
                      <td className="whitespace-pre pr-4">
                        {l.kind === 'add' && <span className="sr-only">added: </span>}
                        {l.kind === 'del' && <span className="sr-only">removed: </span>}
                        <Code line={l} language={language} range={ranges.get(idx)} />
                      </td>
                    </tr>
                    {found && (
                      <tr>
                        <td
                          colSpan={3}
                          className={`diff-issue diff-issue-${worst(found)} font-sans`}
                        >
                          <ul
                            className="flex flex-col divide-y divide-white/10"
                            aria-label={`Issues on line ${l.newLine}`}
                          >
                            {found.map((i) => (
                              <IssueNote key={i.id} issue={i} target={target} />
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

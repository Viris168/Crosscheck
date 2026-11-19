import type { ProviderId, ReviewIssue, RiskLevel, RiskResult, Severity } from '@app/shared';
import { escapeInline, escapeMarkdown, fenceFor } from './escape';

/** Hidden marker that identifies our summary reviews (used to mark them outdated later). */
export const SUMMARY_MARKER = '<!-- ai-code-review:summary -->';
export const OUTDATED_PREFIX = '**Outdated — see newer review**';

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '🔵 Low',
};

const LEVEL_BADGE: Record<RiskLevel, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  platform: 'platform default',
  claude_action: 'Claude (your GitHub Action)',
  codex_action: 'Codex (your GitHub Action)',
  codex_chatgpt: 'Codex (Sign in with ChatGPT)',
};

function normalizeFix(fix: string): string {
  return fix.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

/**
 * A GitHub suggestion replaces exactly the commented line(s). Issues target one line, so only a
 * single-line fix is a safe one-click replacement; anything longer is shown as a plain code block.
 */
export function isSuggestable(fix: string | undefined): fix is string {
  if (fix === undefined) return false;
  const n = normalizeFix(fix);
  return n.trim() !== '' && !n.includes('\n');
}

export function formatIssueComment(issue: ReviewIssue): string {
  const parts = [
    `**${SEVERITY_BADGE[issue.severity]} · ${issue.category}** — ${escapeInline(issue.title)}`,
    escapeMarkdown(issue.explanation.trim()),
  ];
  const fix = issue.suggested_fix;
  if (fix !== undefined && fix.trim() !== '') {
    const content = normalizeFix(fix);
    const fence = fenceFor(content);
    if (isSuggestable(fix)) {
      parts.push(`${fence}suggestion\n${content}\n${fence}`);
    } else {
      parts.push(`**Suggested fix**\n\n${fence}\n${content}\n${fence}`);
    }
  }
  return parts.filter((p) => p !== '').join('\n\n');
}

function formatPoints(points: number): string {
  return `${points >= 0 ? '+' : ''}${points}`;
}

/** Only http(s) URLs become links; anything else is dropped. */
function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function formatSummary(args: {
  risk: RiskResult;
  summary: string;
  issueCount: number;
  postedCount: number;
  provider: ProviderId;
  dashboardUrl: string;
}): string {
  const { risk } = args;
  const lines: string[] = [
    SUMMARY_MARKER,
    `## ${LEVEL_BADGE[risk.level]} AI review — risk ${risk.score}/100 (${risk.level})`,
  ];
  const summary = args.summary.trim();
  if (summary) lines.push('', escapeMarkdown(summary));

  if (risk.factors.length > 0) {
    lines.push('', '| Risk factor | Points |', '|---|---:|');
    for (const f of risk.factors)
      lines.push(`| ${escapeInline(f.label)} | ${formatPoints(f.points)} |`);
  }

  const notInline = args.issueCount - args.postedCount;
  let counts =
    args.issueCount === 0
      ? 'No findings.'
      : `**${args.issueCount} finding${args.issueCount === 1 ? '' : 's'}**, ${args.postedCount} posted inline`;
  if (args.issueCount > 0 && notInline > 0)
    counts += ` (${notInline} listed below or in the dashboard)`;
  if (args.issueCount > 0) counts += '.';

  const footer = [`Reviewed by ${PROVIDER_LABEL[args.provider]}`];
  const url = safeUrl(args.dashboardUrl);
  if (url) footer.push(`[Open in dashboard](${url})`);
  lines.push('', counts, '', `<sub>${footer.join(' · ')}</sub>`);
  return lines.join('\n');
}

/** Markdown list of findings that could not be posted inline. */
export function formatOverflowList(issues: ReviewIssue[]): string {
  if (issues.length === 0) return '';
  const items = issues.map(
    (i) =>
      `- **${SEVERITY_BADGE[i.severity]}** ${escapeInline(`${i.file}:${i.line}`)} — ${escapeInline(i.title)}`,
  );
  return [`### Not posted inline (${issues.length})`, '', ...items].join('\n');
}

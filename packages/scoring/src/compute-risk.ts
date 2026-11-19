import type { ReviewIssue, RiskFactor, RiskLevel, RiskResult, Severity } from '@app/shared';
import { isSensitivePath, isSourcePath, isTestPath } from './paths';
import {
  AI_SCORE_WEIGHT,
  ISSUE_POINTS,
  ISSUE_POINTS_CAP,
  LEVEL_BOUNDS,
  NO_TESTS_POINTS,
  SENSITIVE_PATH_POINTS,
  SIZE_THRESHOLDS,
} from './weights';

export interface ComputeRiskInput {
  /** One per chunk (or one from an Action result), 0–100. */
  aiScores: number[];
  issues: Pick<ReviewIssue, 'severity'>[];
  pr: { additions: number; deletions: number; changedFiles: number };
  /** Changed file paths. */
  paths: string[];
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function riskLevel(score: number): RiskLevel {
  for (const { below, level } of LEVEL_BOUNDS) if (score < below) return level;
  return 'critical';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function computeRisk(input: ComputeRiskInput): RiskResult {
  const factors: RiskFactor[] = [];

  // AI score: max of chunk scores, ignoring junk values.
  const scores = input.aiScores.filter((s) => Number.isFinite(s)).map((s) => clamp(s, 0, 100));
  if (scores.length > 0) {
    const max = Math.max(...scores);
    const points = round1(max * AI_SCORE_WEIGHT);
    if (points > 0)
      factors.push({ key: 'ai_score', label: `AI risk score ${Math.round(max)}/100`, points });
  }

  // Issues by severity, capped.
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of input.issues) counts[issue.severity] += 1;
  const rawIssuePoints = SEVERITY_ORDER.reduce((sum, s) => sum + counts[s] * ISSUE_POINTS[s], 0);
  const issuePoints = Math.min(rawIssuePoints, ISSUE_POINTS_CAP);
  if (issuePoints > 0) {
    const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0 && ISSUE_POINTS[s] > 0).map(
      (s) => `${counts[s]} ${s}`,
    );
    const capped = rawIssuePoints > ISSUE_POINTS_CAP ? ' (capped)' : '';
    factors.push({
      key: 'issues',
      label: `Findings: ${parts.join(', ')}${capped}`,
      points: issuePoints,
    });
  }

  // PR size.
  const lines = Math.max(0, input.pr.additions) + Math.max(0, input.pr.deletions);
  const size = SIZE_THRESHOLDS.find((t) => lines > t.over);
  if (size) {
    factors.push({
      key: 'pr_size',
      label: `Large change: ${lines.toLocaleString('en-US')} lines (> ${size.over.toLocaleString('en-US')})`,
      points: size.points,
    });
  }

  // Sensitive paths.
  const sensitive = input.paths.filter(isSensitivePath);
  if (sensitive.length > 0) {
    const shown = sensitive.slice(0, 3).join(', ');
    const more = sensitive.length > 3 ? ` and ${sensitive.length - 3} more` : '';
    factors.push({
      key: 'sensitive_paths',
      label: `Touches sensitive paths: ${shown}${more}`,
      points: SENSITIVE_PATH_POINTS,
    });
  }

  // Source changed without tests.
  const sourceCount = input.paths.filter(isSourcePath).length;
  if (sourceCount > 0 && !input.paths.some(isTestPath)) {
    factors.push({
      key: 'no_tests',
      label: `${plural(sourceCount, 'source file')} changed with no test changes`,
      points: NO_TESTS_POINTS,
    });
  }

  const score = Math.round(
    clamp(
      factors.reduce((sum, f) => sum + f.points, 0),
      0,
      100,
    ),
  );
  return { score, level: riskLevel(score), factors };
}

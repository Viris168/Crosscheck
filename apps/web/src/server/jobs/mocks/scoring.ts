// Mock of `@app/scoring` (lane E) with the signature from tasks/E-scoring-comments.md.
// TODO(lane E): delete this file and import `computeRisk` from '@app/scoring' in ../deps.ts.
import type { ReviewIssue, RiskFactor, RiskResult } from '@app/shared';

export interface ComputeRiskInput {
  aiScores: number[];
  issues: ReviewIssue[];
  pr: { additions: number; deletions: number; changedFiles: number };
  paths: string[];
}

/** Simplified formula: AI score × 0.4 + issue points (capped at 40). Good enough to exercise the flow. */
export function computeRisk(input: ComputeRiskInput): RiskResult {
  const factors: RiskFactor[] = [];
  const ai = input.aiScores.length > 0 ? Math.max(...input.aiScores) : 0;
  if (ai > 0)
    factors.push({ key: 'ai_score', label: 'AI risk score', points: Math.round(ai * 0.4) });
  const weight = { critical: 15, high: 8, medium: 3, low: 0 } as const;
  const issuePoints = Math.min(
    40,
    input.issues.reduce((n, i) => n + weight[i.severity], 0),
  );
  if (issuePoints > 0) factors.push({ key: 'issues', label: 'Issues found', points: issuePoints });
  const score = Math.max(
    0,
    Math.min(
      100,
      factors.reduce((n, f) => n + f.points, 0),
    ),
  );
  const level = score < 25 ? 'low' : score < 50 ? 'medium' : score < 75 ? 'high' : 'critical';
  return { score, level, factors };
}

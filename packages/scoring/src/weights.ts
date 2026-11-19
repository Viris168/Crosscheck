// All risk-score knobs in one place so they are easy to tune.
import type { RiskLevel, Severity } from '@app/shared';

/** Multiplier applied to the highest AI chunk score (0–100). */
export const AI_SCORE_WEIGHT = 0.4;

/** Points per issue, by severity. */
export const ISSUE_POINTS: Record<Severity, number> = {
  critical: 15,
  high: 8,
  medium: 3,
  low: 0,
};
/** Upper bound for the summed issue points. */
export const ISSUE_POINTS_CAP = 40;

/** Lines changed (additions + deletions) thresholds, checked largest first. */
export const SIZE_THRESHOLDS: ReadonlyArray<{ over: number; points: number }> = [
  { over: 1500, points: 10 },
  { over: 500, points: 5 },
];

export const SENSITIVE_PATH_POINTS = 10;
/** Matched case-insensitively against each changed path. */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z])(o?auth[nz]?(?![a-z])|authenticat|authoriz)/i, // not `author`
  /payment/i,
  /billing/i,
  /migration/i,
  /security/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)[^/]*dockerfile[^/]*$/i,
  /(^|\/)infra(\/|$)/i,
];

export const NO_TESTS_POINTS = 8;

/** Score below `below` → level. Anything at or above the last bound is `critical`. */
export const LEVEL_BOUNDS: ReadonlyArray<{ below: number; level: RiskLevel }> = [
  { below: 25, level: 'low' },
  { below: 50, level: 'medium' },
  { below: 75, level: 'high' },
];

import type { ReviewIssue } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { computeRisk, isSensitivePath, isSourcePath, isTestPath, riskLevel } from './index';

const pr = (additions = 10, deletions = 0) => ({ additions, deletions, changedFiles: 1 });
const issues = (...sev: ReviewIssue['severity'][]) => sev.map((severity) => ({ severity }));
const base = { aiScores: [], issues: [], pr: pr(), paths: ['README.md'] };

function factor(result: ReturnType<typeof computeRisk>, key: string) {
  return result.factors.find((f) => f.key === key);
}

describe('computeRisk — AI score', () => {
  it.each([
    [[50], 20],
    [[10, 80, 30], 32],
    [[100], 40],
    [[150], 40], // clamped to 100
    [[-5], undefined], // clamped to 0 → no factor
    [[], undefined],
    [[Number.NaN, 25], 10],
  ])('aiScores %j → %s points', (aiScores, points) => {
    const r = computeRisk({ ...base, aiScores });
    expect(factor(r, 'ai_score')?.points).toBe(points);
  });

  it('keeps fractional points and rounds the total', () => {
    const r = computeRisk({ ...base, aiScores: [73] });
    expect(factor(r, 'ai_score')?.points).toBe(29.2);
    expect(r.score).toBe(29);
    expect(factor(r, 'ai_score')?.label).toBe('AI risk score 73/100');
  });
});

describe('computeRisk — issues', () => {
  it.each([
    [issues('critical'), 15],
    [issues('high'), 8],
    [issues('medium'), 3],
    [issues('low'), undefined],
    [issues('critical', 'high', 'medium', 'low'), 26],
    [issues('critical', 'critical', 'critical'), 40], // 45 → cap 40
    [issues('high', 'high', 'high', 'high', 'high'), 40],
  ])('%j → %s points', (list, points) => {
    expect(factor(computeRisk({ ...base, issues: list }), 'issues')?.points).toBe(points);
  });

  it('labels counts by severity and notes the cap', () => {
    const r = computeRisk({
      ...base,
      issues: issues('critical', 'critical', 'critical', 'medium'),
    });
    expect(factor(r, 'issues')?.label).toBe('Findings: 3 critical, 1 medium (capped)');
  });
});

describe('computeRisk — PR size', () => {
  it.each([
    [500, 0, undefined],
    [300, 201, 5],
    [1500, 0, 5],
    [1000, 501, 10],
    [5000, 5000, 10],
  ])('+%i -%i → %s', (a, d, points) => {
    expect(factor(computeRisk({ ...base, pr: pr(a, d) }), 'pr_size')?.points).toBe(points);
  });
});

describe('computeRisk — sensitive paths', () => {
  it.each([
    'src/auth/session.ts',
    'lib/oauth.ts',
    'app/payments/charge.rb',
    'services/billing.go',
    'db/migrations/001_init.sql',
    'prisma/migration_lock.toml',
    'src/security/csp.ts',
    '.github/workflows/ci.yml',
    'Dockerfile',
    'infra/docker/web.Dockerfile',
    'infra/compose.prod.yml',
  ])('%s is sensitive', (p) => expect(isSensitivePath(p)).toBe(true));

  it.each(['src/author.ts', 'docs/readme.md', 'src/components/button.tsx', 'infrastructure.md'])(
    '%s is not sensitive',
    (p) => expect(isSensitivePath(p)).toBe(false),
  );

  it('adds 10 points once and lists up to 3 paths', () => {
    const paths = ['a/auth.ts', 'billing.ts', 'Dockerfile', 'infra/x.yml', 'README.md'];
    const r = computeRisk({ ...base, paths });
    expect(factor(r, 'sensitive_paths')).toEqual({
      key: 'sensitive_paths',
      label: 'Touches sensitive paths: a/auth.ts, billing.ts, Dockerfile and 1 more',
      points: 10,
    });
  });
});

describe('computeRisk — missing tests', () => {
  it.each([
    [['src/a.ts'], 8],
    [['src/a.ts', 'src/a.test.ts'], undefined],
    [['pkg/a.go', 'pkg/a_test.go'], undefined],
    [['app/x.py', 'tests/test_x.py'], undefined],
    [['src/a.ts', 'src/__tests__/a.ts'], undefined],
    [['README.md', 'package.json'], undefined],
    [['src/a.test.ts'], undefined],
  ])('%j → %s', (paths, points) => {
    expect(factor(computeRisk({ ...base, paths }), 'no_tests')?.points).toBe(points);
  });

  it('classifies paths', () => {
    expect(isTestPath('src/foo.spec.tsx')).toBe(true);
    expect(isTestPath('src/FooTest.java')).toBe(true);
    expect(isSourcePath('src/foo.spec.tsx')).toBe(false);
    expect(isSourcePath('Makefile')).toBe(false);
    expect(isSourcePath('.eslintrc')).toBe(false);
    expect(isSourcePath('src/main.rs')).toBe(true);
  });
});

describe('computeRisk — levels and totals', () => {
  it.each([
    [0, 'low'],
    [24.9, 'low'],
    [25, 'medium'],
    [49, 'medium'],
    [50, 'high'],
    [74, 'high'],
    [75, 'critical'],
    [100, 'critical'],
  ] as const)('riskLevel(%s) = %s', (score, level) => expect(riskLevel(score)).toBe(level));

  it.each([
    [[62], 'medium', 25], // 24.8 → 25
    [[60], 'low', 24],
  ] as const)('boundary via aiScores %j', (aiScores, level, score) => {
    const r = computeRisk({ ...base, aiScores: [...aiScores] });
    expect(r.score).toBe(score);
    expect(r.level).toBe(level);
  });

  it('returns no factors and score 0 for a trivial PR', () => {
    expect(computeRisk(base)).toEqual({ score: 0, level: 'low', factors: [] });
  });

  it('sums all factors and clamps at 100', () => {
    const r = computeRisk({
      aiScores: [100],
      issues: issues('critical', 'critical', 'critical'),
      pr: pr(2000, 0),
      paths: ['src/auth/login.ts'],
    });
    // 40 + 40 + 10 + 10 + 8 = 108 → 100
    expect(r.factors.map((f) => f.key)).toEqual([
      'ai_score',
      'issues',
      'pr_size',
      'sensitive_paths',
      'no_tests',
    ]);
    expect(r.score).toBe(100);
    expect(r.level).toBe('critical');
  });

  it('matches the shared RiskResult schema', async () => {
    const { RiskResultSchema } = await import('@app/shared');
    const r = computeRisk({ ...base, aiScores: [40], issues: issues('high'), paths: ['src/a.ts'] });
    expect(RiskResultSchema.parse(r)).toEqual(r);
  });
});

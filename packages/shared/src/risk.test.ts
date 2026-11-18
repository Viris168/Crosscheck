import { describe, expect, it } from 'vitest';
import { RiskFactorSchema, RiskResultSchema } from './risk';

describe('risk schemas', () => {
  it('accepts a valid risk result', () => {
    const r = {
      score: 72,
      level: 'high',
      factors: [{ key: 'sensitive_paths', label: 'Touches auth code', points: 15 }],
    };
    expect(RiskResultSchema.parse(r)).toEqual(r);
  });

  it('rejects an unknown level and malformed factors', () => {
    expect(RiskResultSchema.safeParse({ score: 1, level: 'extreme', factors: [] }).success).toBe(
      false,
    );
    expect(RiskFactorSchema.safeParse({ key: 'x', label: 'y' }).success).toBe(false);
  });
});

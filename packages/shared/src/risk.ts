import { z } from 'zod';

export const RiskLevel = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RiskLevel)[number];

export const RiskFactorSchema = z.object({
  key: z.string(),
  label: z.string(),
  points: z.number(),
});

export const RiskResultSchema = z.object({
  score: z.number(),
  level: z.enum(RiskLevel),
  factors: z.array(RiskFactorSchema),
});

export type RiskFactor = z.infer<typeof RiskFactorSchema>;
export type RiskResult = z.infer<typeof RiskResultSchema>;

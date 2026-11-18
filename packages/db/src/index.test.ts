import {
  Category,
  ErrorCode,
  PullRequestState,
  ProviderId,
  ReviewStatus,
  RiskLevel,
  Severity,
} from '@app/shared';
import { describe, expect, it } from 'vitest';
import { $Enums, prisma } from './index';

// Prisma enums must stay in sync with the @app/shared contracts.
describe('@app/db', () => {
  it.each([
    ['ProviderId', $Enums.ProviderId, ProviderId],
    ['ReviewStatus', $Enums.ReviewStatus, ReviewStatus],
    ['ErrorCode', $Enums.ErrorCode, ErrorCode],
    ['Severity', $Enums.Severity, Severity],
    ['Category', $Enums.Category, Category],
    ['RiskLevel', $Enums.RiskLevel, RiskLevel],
    ['PullRequestState', $Enums.PullRequestState, PullRequestState],
  ] as const)('%s matches @app/shared', (_name, prismaEnum, shared) => {
    expect(Object.values(prismaEnum).sort()).toEqual([...shared].sort());
  });

  it('exports a singleton client without connecting', () => {
    expect(prisma).toBeDefined();
    expect(typeof prisma.review.findMany).toBe('function');
  });
});

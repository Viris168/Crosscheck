import { describe, expect, it } from 'vitest';
import { IssueSchema, ReviewResultSchema } from './review-result';

const issue = {
  file: 'src/a.ts',
  line: 10,
  severity: 'high',
  category: 'security',
  title: 'SQL injection',
  explanation: 'User input is concatenated into SQL.',
};

const result = {
  schema_version: 1,
  repo: 'acme/web',
  pr_number: 42,
  head_sha: 'abc123',
  risk_score: 55,
  summary: 'Looks mostly fine.',
  issues: [issue],
};

describe('IssueSchema', () => {
  it('accepts a valid issue with and without suggested_fix', () => {
    expect(IssueSchema.parse(issue)).toEqual(issue);
    expect(IssueSchema.parse({ ...issue, suggested_fix: 'use params' }).suggested_fix).toBe(
      'use params',
    );
  });

  it.each([
    ['line 0', { line: 0 }],
    ['fractional line', { line: 1.5 }],
    ['unknown severity', { severity: 'blocker' }],
    ['unknown category', { category: 'docs' }],
    ['title too long', { title: 'x'.repeat(201) }],
    ['explanation too long', { explanation: 'x'.repeat(4001) }],
    ['suggested_fix too long', { suggested_fix: 'x'.repeat(8001) }],
  ])('rejects %s', (_name, patch) => {
    expect(IssueSchema.safeParse({ ...issue, ...patch }).success).toBe(false);
  });
});

describe('ReviewResultSchema', () => {
  it('accepts a valid result', () => {
    expect(ReviewResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    ['schema_version 2', { schema_version: 2 }],
    ['risk_score > 100', { risk_score: 101 }],
    ['risk_score < 0', { risk_score: -1 }],
    ['summary too long', { summary: 'x'.repeat(4001) }],
    ['too many issues', { issues: Array.from({ length: 201 }, () => issue) }],
    ['missing head_sha', { head_sha: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(ReviewResultSchema.safeParse({ ...result, ...patch }).success).toBe(false);
  });

  it('strips unknown keys', () => {
    const parsed = ReviewResultSchema.parse({ ...result, extra: 'nope' });
    expect(parsed).not.toHaveProperty('extra');
  });
});

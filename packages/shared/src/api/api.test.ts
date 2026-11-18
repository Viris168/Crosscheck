import { describe, expect, it } from 'vitest';
import {
  GetPullResponse,
  GetRepoSettingsResponse,
  IngestRequest,
  IngestResponse,
  ListPullsQuery,
  ListPullsResponse,
  ListReposResponse,
  OverviewQuery,
  OverviewResponse,
  PullParams,
  PutRepoSettingsRequest,
  RerunRequest,
  RetryReviewResponse,
  ReviewDetailSchema,
  RotateIngestTokenResponse,
  WorkflowPrRequest,
  WorkflowPrResponse,
} from './index';

const now = new Date().toISOString();

const reviewDetail = {
  id: 'rev_1',
  status: 'completed',
  provider: 'platform',
  headSha: 'abc',
  stale: false,
  errorCode: null,
  errorMessage: null,
  filesTotal: 3,
  filesDone: 3,
  risk: { score: 40, level: 'medium', factors: [] },
  summary: 'ok',
  issues: [
    {
      id: 'iss_1',
      posted: true,
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      title: 't',
      explanation: 'e',
    },
  ],
  createdAt: now,
  finishedAt: now,
};

describe('repos API', () => {
  it('parses list + settings', () => {
    expect(
      ListReposResponse.parse([
        {
          id: 'r',
          orgId: 'o',
          fullName: 'a/b',
          provider: 'platform',
          active: true,
          hasIngestToken: false,
        },
      ]),
    ).toHaveLength(1);
    const settings = GetRepoSettingsResponse.parse({
      repoId: 'r',
      provider: 'claude_action',
      settings: {},
      hasIngestToken: true,
    });
    expect(settings.settings.maxIssuesPerPr).toBe(30);
    expect(PutRepoSettingsRequest.safeParse({ provider: 'gpt', settings: {} }).success).toBe(false);
  });

  it('ingest token response requires the rit_ prefix', () => {
    expect(RotateIngestTokenResponse.safeParse({ token: 'rit_abc' }).success).toBe(true);
    expect(RotateIngestTokenResponse.safeParse({ token: 'abc' }).success).toBe(false);
  });

  it('workflow PR only for action providers', () => {
    expect(WorkflowPrRequest.safeParse({ provider: 'claude_action' }).success).toBe(true);
    expect(WorkflowPrRequest.safeParse({ provider: 'platform' }).success).toBe(false);
    expect(
      WorkflowPrResponse.parse({ prNumber: 3, prUrl: 'https://github.com/a/b/pull/3' }).prNumber,
    ).toBe(3);
  });
});

describe('pulls API', () => {
  it('defaults state to open and rejects unknown states', () => {
    expect(ListPullsQuery.parse({}).state).toBe('open');
    expect(ListPullsQuery.parse({ state: 'all' }).state).toBe('all');
    expect(ListPullsQuery.safeParse({ state: 'merged' }).success).toBe(false);
  });

  it('coerces the PR number from the path', () => {
    expect(PullParams.parse({ repoId: 'r', number: '12' })).toEqual({ repoId: 'r', number: 12 });
    expect(PullParams.safeParse({ repoId: 'r', number: 'abc' }).success).toBe(false);
  });

  it('parses list items and the PR detail', () => {
    expect(
      ListPullsResponse.parse([
        {
          id: 'p',
          number: 1,
          title: 't',
          author: 'u',
          state: 'merged',
          additions: 1,
          deletions: 2,
          changedFiles: 1,
          latestReview: { status: 'running', stale: true },
        },
      ])[0]?.latestReview?.stale,
    ).toBe(true);

    const detail = GetPullResponse.parse({
      pull: {
        id: 'p',
        repoId: 'r',
        repoFullName: 'a/b',
        number: 1,
        title: 't',
        body: null,
        author: 'u',
        state: 'open',
        headSha: 'abc',
        baseRef: 'main',
        headRef: 'feat',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        updatedAt: now,
        htmlUrl: 'https://github.com/a/b/pull/1',
      },
      review: reviewDetail,
      reviews: [
        {
          id: 'rev',
          status: 'cancelled',
          provider: 'platform',
          headSha: 'abc',
          stale: false,
          createdAt: now,
        },
      ],
      files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@' }],
    });
    expect(detail.review?.issues[0]?.id).toBe('iss_1');
    expect(detail.reviews[0]?.status).toBe('cancelled');
  });

  it('rerun provider is optional but must be known', () => {
    expect(RerunRequest.parse({})).toEqual({});
    expect(RerunRequest.safeParse({ provider: 'x' }).success).toBe(false);
  });
});

describe('reviews API', () => {
  it('parses a review detail with nulls from the database', () => {
    expect(
      ReviewDetailSchema.parse({ ...reviewDetail, risk: null, summary: null }).risk,
    ).toBeNull();
  });

  it('rejects a non-ISO date and unknown error code', () => {
    expect(ReviewDetailSchema.safeParse({ ...reviewDetail, createdAt: 'yesterday' }).success).toBe(
      false,
    );
    expect(ReviewDetailSchema.safeParse({ ...reviewDetail, errorCode: 'oops' }).success).toBe(
      false,
    );
  });

  it('retry response', () => {
    expect(RetryReviewResponse.parse({ reviewId: 'r', status: 'queued' }).status).toBe('queued');
  });
});

describe('orgs API', () => {
  it('overview defaults to 30d', () => {
    expect(OverviewQuery.parse({}).range).toBe('30d');
    expect(OverviewQuery.safeParse({ range: '7d' }).success).toBe(false);
  });

  it('parses an overview', () => {
    const o = OverviewResponse.parse({
      range: '90d',
      totals: {
        repos: 1,
        openPulls: 2,
        reviews: 3,
        completed: 2,
        failed: 1,
        issues: 4,
        avgRiskScore: null,
      },
      openPullsByRiskLevel: { low: 1, medium: 0, high: 0, critical: 0, unreviewed: 1 },
      riskOverTime: [{ date: '2026-11-18', reviews: 1, avgRiskScore: 20 }],
      issuesByCategory: { security: 1, bug: 1, performance: 0, style: 2, test: 0 },
      issuesBySeverity: { low: 2, medium: 1, high: 1, critical: 0 },
    });
    expect(o.range).toBe('90d');
  });
});

describe('ingest API', () => {
  it('accepts a ReviewResult or the no_output shape', () => {
    const ok = IngestRequest.parse({
      schema_version: 1,
      repo: 'a/b',
      pr_number: 1,
      head_sha: 'abc',
      risk_score: 0,
      summary: '',
      issues: [],
    });
    expect('schema_version' in ok).toBe(true);
    const none = IngestRequest.parse({ error: 'no_output' });
    expect('error' in none && none.error).toBe('no_output');
    expect(IngestRequest.safeParse({ error: 'other' }).success).toBe(false);
    expect(IngestRequest.safeParse({}).success).toBe(false);
  });

  it('response defaults duplicate to false', () => {
    expect(IngestResponse.parse({ reviewId: 'r' })).toEqual({ reviewId: 'r', duplicate: false });
  });
});

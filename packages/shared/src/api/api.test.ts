import { describe, expect, it } from 'vitest';
import {
  GetPullResponse,
  GetRepoSettingsResponse,
  IngestRequest,
  IngestResponse,
  ListMembersResponse,
  ListPullsQuery,
  ListPullsResponse,
  ListReposResponse,
  MemberParams,
  OverviewQuery,
  OverviewResponse,
  PullParams,
  PutRepoSettingsRequest,
  RerunRequest,
  RetryReviewResponse,
  ReviewDetailSchema,
  RotateIngestTokenResponse,
  SyncOrgsResponse,
  UpdateMemberBody,
  UpdateMemberResponse,
  WorkflowPrRequest,
  WorkflowPrResponse,
} from './index';
import {
  BranchNodeSchema,
  CompareQuery,
  CompareResponse,
  GetTreeQuery,
  GetTreeResponse,
  SetCompareWithBody,
  SetCompareWithResponse,
  SyncTreeResponse,
  TREE_MAX_BRANCHES,
  TREE_MAX_COMMITS,
  TreeParams,
  TreeSnapshotSchema,
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
    // canEdit defaults to false (fail closed) when a handler doesn't set it.
    expect(settings.canEdit).toBe(false);
    expect(
      GetRepoSettingsResponse.parse({
        repoId: 'r',
        provider: 'platform',
        settings: {},
        hasIngestToken: false,
        canEdit: true,
      }).canEdit,
    ).toBe(true);
    expect(
      GetRepoSettingsResponse.safeParse({
        repoId: 'r',
        provider: 'platform',
        settings: {},
        hasIngestToken: false,
        canEdit: 'yes',
      }).success,
    ).toBe(false);
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

describe('members API', () => {
  const member = {
    id: 'm1',
    userId: 'u1',
    login: 'octocat',
    name: 'Octo Cat',
    avatarUrl: null,
    role: 'member',
  };

  it('member params need orgId and memberId', () => {
    expect(MemberParams.parse({ orgId: 'o', memberId: 'm' })).toEqual({
      orgId: 'o',
      memberId: 'm',
    });
    expect(MemberParams.safeParse({ orgId: 'o' }).success).toBe(false);
    expect(MemberParams.safeParse({ orgId: 'o', memberId: '' }).success).toBe(false);
  });

  it('parses a member list', () => {
    const r = ListMembersResponse.parse({
      members: [member, { ...member, id: 'm2', login: null, role: 'owner' }],
      needsMemberPermission: true,
    });
    expect(r.members).toHaveLength(2);
    expect(ListMembersResponse.safeParse({ members: [member] }).success).toBe(false);
    expect(
      ListMembersResponse.safeParse({
        members: [{ ...member, role: 'superuser' }],
        needsMemberPermission: false,
      }).success,
    ).toBe(false);
  });

  it('update member body/response', () => {
    expect(UpdateMemberBody.parse({ role: 'admin' }).role).toBe('admin');
    expect(UpdateMemberBody.safeParse({ role: 'root' }).success).toBe(false);
    expect(UpdateMemberBody.safeParse({}).success).toBe(false);
    expect(UpdateMemberResponse.parse({ member }).member.id).toBe('m1');
  });

  it('sync orgs response', () => {
    expect(SyncOrgsResponse.parse({ joined: ['o1'], left: [] })).toEqual({
      joined: ['o1'],
      left: [],
    });
    expect(SyncOrgsResponse.safeParse({ joined: ['o1'] }).success).toBe(false);
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

describe('tree API', () => {
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  const node = (over: Record<string, unknown> = {}) => ({
    name: 'feature/login',
    headSha: sha(3),
    isDefault: false,
    compareWith: 'dev',
    why: 'pr',
    whyPr: 2,
    ambiguous: null,
    loop: false,
    ahead: 3,
    behind: 1,
    mergeBase: sha(2),
    merged: null,
    pr: { number: 2, state: 'open', baseRef: 'dev' },
    ci: 'success',
    recorded: false,
    ...over,
  });
  const main = node({
    name: 'main',
    headSha: sha(1),
    isDefault: true,
    compareWith: null,
    why: 'default',
    whyPr: null,
    ahead: 0,
    behind: 0,
    mergeBase: null,
    pr: null,
  });
  const snapshot = (over: Record<string, unknown> = {}) => ({
    defaultBranch: 'main',
    branches: [main, node()],
    commits: [
      { sha: sha(1), parents: [], committedAt: now },
      { sha: sha(2), parents: [sha(1)], committedAt: now },
      { sha: sha(3), parents: [sha(2)], committedAt: now },
    ],
    truncated: false,
    ...over,
  });

  it('parses a branch node and a snapshot', () => {
    expect(BranchNodeSchema.parse(node()).compareWith).toBe('dev');
    expect(
      BranchNodeSchema.parse(
        node({
          merged: { via: 'pr', prNumber: 1, method: 'squash', into: 'main', newCommits: 0 },
        }),
      ).merged?.via,
    ).toBe('pr');
    expect(
      BranchNodeSchema.parse(
        node({
          merged: { via: 'rebased', prNumber: null, method: null, into: 'main', newCommits: 0 },
        }),
      ).merged?.method,
    ).toBeNull();
    expect(TreeSnapshotSchema.parse(snapshot()).branches).toHaveLength(2);
  });

  it('rejects unknown why, ci, merged.via and bad SHAs', () => {
    expect(BranchNodeSchema.safeParse(node({ why: 'manual' })).success).toBe(false);
    expect(BranchNodeSchema.safeParse(node({ ci: 'error' })).success).toBe(false);
    expect(
      BranchNodeSchema.safeParse(
        node({
          merged: { via: 'cherry', prNumber: null, method: null, into: 'main', newCommits: 0 },
        }),
      ).success,
    ).toBe(false);
    expect(BranchNodeSchema.safeParse(node({ headSha: 'abc' })).success).toBe(false);
    expect(BranchNodeSchema.safeParse(node({ headSha: sha(3).toUpperCase() + 'X' })).success).toBe(
      false,
    );
    expect(BranchNodeSchema.safeParse(node({ headSha: 'a'.repeat(64) })).success).toBe(true);
  });

  it('carries no commit messages, emails or file names', () => {
    const parsed = TreeSnapshotSchema.parse(
      snapshot({
        commits: [
          { sha: sha(1), parents: [], committedAt: now, message: 'secret', author: 'a@b.c' },
        ],
        branches: [main],
      }),
    );
    expect(parsed.commits[0]).toEqual({ sha: sha(1), parents: [], committedAt: now });
  });

  it('compareWith: required; null only on the default branch', () => {
    const { compareWith: _omit, ...missing } = node();
    expect(BranchNodeSchema.safeParse(missing).success).toBe(false);
    expect(BranchNodeSchema.safeParse(node({ compareWith: null })).success).toBe(true);
    expect(
      TreeSnapshotSchema.safeParse(snapshot({ branches: [main, node({ compareWith: null })] }))
        .success,
    ).toBe(false);
    expect(
      TreeSnapshotSchema.safeParse(snapshot({ branches: [{ ...main, isDefault: false }] })).success,
    ).toBe(false);
  });

  it('caps arrays and names', () => {
    expect(BranchNodeSchema.safeParse(node({ name: 'x'.repeat(256) })).success).toBe(false);
    expect(BranchNodeSchema.safeParse(node({ name: 'x'.repeat(255) })).success).toBe(true);
    expect(BranchNodeSchema.safeParse(node({ name: '' })).success).toBe(false);
    const branches = Array.from({ length: TREE_MAX_BRANCHES + 1 }, (_, i) =>
      node({ name: `b${i}` }),
    );
    expect(TreeSnapshotSchema.safeParse(snapshot({ branches })).success).toBe(false);
    const commits = Array.from({ length: TREE_MAX_COMMITS + 1 }, (_, i) => ({
      sha: sha(i + 1),
      parents: [],
      committedAt: now,
    }));
    expect(TreeSnapshotSchema.safeParse(snapshot({ commits })).success).toBe(false);
  });

  it('parses GET /tree query + response', () => {
    expect(TreeParams.parse({ repoId: 'r1' })).toEqual({ repoId: 'r1' });
    expect(GetTreeQuery.parse({})).toEqual({});
    expect(GetTreeQuery.parse({ at: now }).at).toBe(now);
    expect(GetTreeQuery.safeParse({ at: 'yesterday' }).success).toBe(false);
    expect(
      GetTreeResponse.parse({
        status: 'ready',
        syncedAt: now,
        errorCode: null,
        snapshot: snapshot(),
        canEdit: true,
      }).status,
    ).toBe('ready');
    expect(
      GetTreeResponse.parse({
        status: 'failed',
        syncedAt: null,
        errorCode: 'github_error',
        snapshot: null,
        canEdit: false,
      }).snapshot,
    ).toBeNull();
    expect(
      GetTreeResponse.safeParse({
        status: 'cloning',
        syncedAt: null,
        errorCode: null,
        snapshot: null,
        canEdit: false,
      }).success,
    ).toBe(false);
  });

  it('parses sync, compare-with and compare', () => {
    expect(SyncTreeResponse.parse({ queued: true })).toEqual({ queued: true });
    expect(SyncTreeResponse.safeParse({ queued: false }).success).toBe(false);
    expect(SetCompareWithBody.parse({ branch: 'a', compareWith: null }).compareWith).toBeNull();
    expect(SetCompareWithBody.parse({ branch: 'a', compareWith: 'dev' }).compareWith).toBe('dev');
    expect(SetCompareWithBody.safeParse({ branch: 'a' }).success).toBe(false);
    expect(SetCompareWithResponse.parse({ branch: node() }).branch.name).toBe('feature/login');
    expect(CompareQuery.parse({ a: 'main', b: 'dev' })).toEqual({ a: 'main', b: 'dev' });
    expect(CompareQuery.safeParse({ a: 'main' }).success).toBe(false);
    expect(CompareResponse.parse({ ahead: 1, behind: 0, mergeBase: sha(1) }).ahead).toBe(1);
    expect(CompareResponse.safeParse({ ahead: -1, behind: 0, mergeBase: null }).success).toBe(
      false,
    );
  });
});

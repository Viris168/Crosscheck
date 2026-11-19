import {
  CancelReviewResponse,
  ApiErrorSchema,
  GetPullResponse,
  GetRepoSettingsResponse,
  HttpError,
  MergeResponse,
  ListPullsResponse,
  ListReposResponse,
  RerunResponse,
  RetryReviewResponse,
  ReviewDetailSchema,
  RotateIngestTokenResponse,
  hashToken,
  type MemberRole,
} from '@app/shared';
import type * as DbModule from '@app/db';
import type * as GithubModule from '@app/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- mocks

process.env.PUBLIC_URL ??= 'http://localhost:3000';

const db = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    repo: { findUnique: fn(), findMany: fn(), update: fn(), count: fn() },
    pullRequest: { findUnique: fn(), findMany: fn(), update: fn() },
    review: {
      findUnique: fn(),
      findMany: fn(),
      findFirst: fn(),
      create: fn(),
      update: fn(),
      updateMany: fn(),
    },
    issue: { findMany: fn(), deleteMany: fn(), groupBy: fn() },
    member: { findMany: fn() },
    installation: { findUnique: fn() },
    providerCredential: { findUnique: fn(), deleteMany: fn(), upsert: fn() },
    $transaction: vi.fn(),
  };
});
vi.mock('@app/db', async () => {
  // Real Prisma namespace (DbNull, error classes); the client itself is replaced.
  const { Prisma } = await vi.importActual<typeof DbModule>('@app/db');
  return { prisma: db, Prisma };
});

/** userId → orgId → role */
const memberships = new Map<string, Map<string, MemberRole>>();
const auth = vi.hoisted(() => ({
  currentUser: null as string | null,
  activeOrg: null as string | null,
}));
vi.mock('@/server/auth', () => ({
  requireSession: vi.fn(async () => {
    if (!auth.currentUser) throw new HttpError('unauthorized', 'Sign in required');
    return {
      user: { id: auth.currentUser },
      session: { activeOrganizationId: auth.activeOrg },
    };
  }),
  requireOrgMember: vi.fn(async (userId: string, orgId: string, roles?: MemberRole[]) => {
    const role = memberships.get(userId)?.get(orgId);
    if (!role) throw new HttpError('forbidden', 'Not a member of this organization');
    if (roles && !roles.includes(role)) throw new HttpError('forbidden', 'Insufficient role');
    return { id: 'm', role };
  }),
}));

const send = vi.hoisted(() => vi.fn());
vi.mock('@/server/jobs', () => ({ inngest: { send } }));

const gh = vi.hoisted(() => ({
  octokit: { tag: 'installation-octokit' },
  getInstallationOctokit: vi.fn(),
  fetchPullRequestFiles: vi.fn(),
  mergePullRequest: vi.fn(),
  openWorkflowPR: vi.fn(),
  renderWorkflow: vi.fn(),
}));
vi.mock('@app/github', async () => ({
  MergeError: (await vi.importActual<typeof GithubModule>('@app/github')).MergeError,
  getInstallationOctokit: gh.getInstallationOctokit,
  fetchPullRequestFiles: gh.fetchPullRequestFiles,
  mergePullRequest: gh.mergePullRequest,
  splitFullName: (n: string) => {
    const [owner, repo] = n.split('/');
    return { owner, repo };
  },
}));
vi.mock('@app/workflow-templates', () => ({
  openWorkflowPR: gh.openWorkflowPR,
  renderWorkflow: gh.renderWorkflow,
}));

const { GET: listRepos } = await import('./repos/route');
const { GET: listPulls } = await import('./repos/[repoId]/pulls/route');
const { GET: getPull } = await import('./repos/[repoId]/pulls/[number]/route');
const { POST: rerun } = await import('./repos/[repoId]/pulls/[number]/rerun/route');
const { POST: merge } = await import('./repos/[repoId]/pulls/[number]/merge/route');
const { MergeError } = await import('@app/github');
const { GET: getReview } = await import('./reviews/[id]/route');
const { POST: retry } = await import('./reviews/[id]/retry/route');
const { POST: cancel } = await import('./reviews/[id]/cancel/route');
const { GET: getSettings, PUT: putSettings } = await import('./repos/[repoId]/settings/route');
const { POST: rotate } = await import('./repos/[repoId]/ingest-token/rotate/route');
const { POST: workflowPr } = await import('./repos/[repoId]/setup/workflow-pr/route');
const { GET: overview } = await import('./orgs/[orgId]/overview/route');
const { GET: getConn, DELETE: deleteConn } = await import('./connections/chatgpt/route');

// ---------------------------------------------------------------- fixtures

const NOW = new Date('2026-11-18T12:00:00Z');
const repo = {
  id: 'r1',
  orgId: 'org1',
  installationId: 'inst1',
  githubRepoId: 1,
  fullName: 'acme/web',
  provider: 'platform',
  settings: {},
  ingestTokenHash: null,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};
const otherRepo = { ...repo, id: 'r2', orgId: 'org2', fullName: 'evil/corp' };
const pull = {
  id: 'p1',
  repoId: 'r1',
  number: 42,
  title: 'feat: x',
  body: null,
  author: 'octo',
  state: 'open',
  headSha: 'head2',
  baseRef: 'main',
  headRef: 'feat',
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  createdAt: NOW,
  updatedAt: NOW,
};
const baseReview = {
  id: 'rev1',
  pullRequestId: 'p1',
  headSha: 'head1',
  provider: 'platform',
  status: 'completed',
  errorCode: null,
  errorMessage: null,
  filesTotal: 2,
  filesDone: 2,
  riskScore: 40,
  riskLevel: 'medium',
  riskFactors: [{ key: 'ai', label: 'AI', points: 40 }],
  summary: 'ok',
  githubReviewId: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
};

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const errCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;

beforeEach(() => {
  vi.clearAllMocks();
  auth.currentUser = 'u1';
  auth.activeOrg = 'org1';
  memberships.clear();
  memberships.set('u1', new Map([['org1', 'member']]));
  db.repo.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      [repo, otherRepo].find((r) => r.id === where.id) ?? null,
  );
  db.member.findMany.mockImplementation(async ({ where }: { where: { userId: string } }) =>
    [...(memberships.get(where.userId) ?? [])].map(([id, role]) => ({
      role,
      organization: { id, name: id, slug: id },
    })),
  );
  db.pullRequest.findUnique.mockResolvedValue(pull);
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  send.mockResolvedValue({ ids: ['e1'] });
});

// ---------------------------------------------------------------- auth + membership

describe('session and membership', () => {
  const unauthenticated: [string, () => Promise<Response>][] = [
    ['GET /api/repos', () => listRepos(req('/api/repos'), ctx({}))],
    ['GET pulls', () => listPulls(req('/api/repos/r1/pulls'), ctx({ repoId: 'r1' }))],
    ['GET pull', () => getPull(req('/api/repos/r1/pulls/42'), ctx({ repoId: 'r1', number: '42' }))],
    ['POST rerun', () => rerun(req('/x', { method: 'POST' }), ctx({ repoId: 'r1', number: '42' }))],
    ['POST merge', () => merge(req('/x', { method: 'POST' }), ctx({ repoId: 'r1', number: '42' }))],
    ['GET review', () => getReview(req('/x'), ctx({ id: 'rev1' }))],
    ['POST retry', () => retry(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }))],
    ['POST cancel', () => cancel(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }))],
    ['GET settings', () => getSettings(req('/x'), ctx({ repoId: 'r1' }))],
    ['POST rotate', () => rotate(req('/x', { method: 'POST' }), ctx({ repoId: 'r1' }))],
    ['GET overview', () => overview(req('/x'), ctx({ orgId: 'org1' }))],
    ['GET chatgpt', () => getConn(req('/x'), ctx({}))],
    ['DELETE chatgpt', () => deleteConn(req('/x', { method: 'DELETE' }), ctx({}))],
  ];
  it.each(unauthenticated)('%s → 401 without a session', async (_name, call) => {
    auth.currentUser = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('unauthorized');
  });

  it("cannot read another org's repo (403)", async () => {
    const res = await listPulls(req('/api/repos/r2/pulls'), ctx({ repoId: 'r2' }));
    expect(res.status).toBe(403);
    expect(db.pullRequest.findMany).not.toHaveBeenCalled();
  });

  it('unknown repo → 404', async () => {
    const res = await getSettings(req('/x'), ctx({ repoId: 'nope' }));
    expect(res.status).toBe(404);
  });

  it("cannot read another org's overview (403)", async () => {
    const res = await overview(req('/x'), ctx({ orgId: 'org2' }));
    expect(res.status).toBe(403);
  });

  it("cannot read or retry another org's review (403)", async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      status: 'failed',
      pullRequest: { ...pull, repo: otherRepo },
    });
    expect((await getReview(req('/x'), ctx({ id: 'rev1' }))).status).toBe(403);
    expect((await retry(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }))).status).toBe(403);
    expect(db.review.updateMany).not.toHaveBeenCalled();
  });

  it('GET /api/repos only lists the current org and ignores an active org the user left', async () => {
    auth.activeOrg = 'org2'; // not a member any more → falls back to the first membership
    db.repo.findMany.mockResolvedValue([{ ...repo, pullRequests: [] }]);
    const res = await listRepos(req('/api/repos'), ctx({}));
    expect(res.status).toBe(200);
    expect(db.repo.findMany.mock.calls[0]?.[0].where).toEqual({ orgId: 'org1' });
    const body = await res.json();
    expect(ListReposResponse.parse(body)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- reads

describe('GET /api/repos/:repoId/pulls', () => {
  it('invalid state → 400', async () => {
    const res = await listPulls(req('/api/repos/r1/pulls?state=merged'), ctx({ repoId: 'r1' }));
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('bad_request');
  });

  it.each([
    ['open', { state: 'open' }],
    ['closed', { state: { in: ['closed', 'merged'] } }],
    ['all', {}],
  ])('filters by state=%s', async (state, filter) => {
    db.pullRequest.findMany.mockResolvedValue([{ ...pull, reviews: [baseReview] }]);
    const res = await listPulls(req(`/api/repos/r1/pulls?state=${state}`), ctx({ repoId: 'r1' }));
    expect(res.status).toBe(200);
    expect(db.pullRequest.findMany.mock.calls[0]?.[0].where).toEqual({ repoId: 'r1', ...filter });
    const [item] = ListPullsResponse.parse(await res.json());
    expect(item?.latestReview).toMatchObject({
      status: 'completed',
      riskLevel: 'medium',
      stale: true,
    });
  });

  it('defaults to open', async () => {
    db.pullRequest.findMany.mockResolvedValue([]);
    await listPulls(req('/api/repos/r1/pulls'), ctx({ repoId: 'r1' }));
    expect(db.pullRequest.findMany.mock.calls[0]?.[0].where).toEqual({
      repoId: 'r1',
      state: 'open',
    });
  });
});

describe('GET /api/repos/:repoId/pulls/:number', () => {
  it('bad number → 400', async () => {
    const res = await getPull(req('/x'), ctx({ repoId: 'r1', number: 'abc' }));
    expect(res.status).toBe(400);
  });

  it('missing PR → 404', async () => {
    db.pullRequest.findUnique.mockResolvedValue(null);
    const res = await getPull(req('/x'), ctx({ repoId: 'r1', number: '9' }));
    expect(res.status).toBe(404);
  });

  it('loads changed files live from GitHub with the installation token', async () => {
    db.review.findMany.mockResolvedValue([]);
    db.review.findFirst.mockResolvedValue(null);
    db.installation.findUnique.mockResolvedValue({ id: 'inst1', githubInstallationId: 7 });
    gh.getInstallationOctokit.mockResolvedValue(gh.octokit);
    gh.fetchPullRequestFiles.mockResolvedValue([
      { path: 'a.ts', status: 'modified', patch: '@@ -1,2 +1,2 @@\n-a\n+b\n+c\n ctx' },
      { path: 'logo.png', status: 'added', patch: '' },
    ]);
    const res = await getPull(req('/x'), ctx({ repoId: 'r1', number: '42' }));
    expect(res.status).toBe(200);
    const body = GetPullResponse.parse(await res.json());
    expect(gh.fetchPullRequestFiles).toHaveBeenCalledWith(gh.octokit, 'acme', 'web', 42);
    expect(body.files).toEqual([
      { path: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: expect.any(String) },
      { path: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: null },
    ]);
  });

  it('a GitHub failure does not hide the review (files: [])', async () => {
    db.review.findMany.mockResolvedValue([]);
    db.review.findFirst.mockResolvedValue(null);
    db.installation.findUnique.mockResolvedValue({ id: 'inst1', githubInstallationId: 7 });
    gh.getInstallationOctokit.mockRejectedValue(new Error('bad credentials'));
    const res = await getPull(req('/x'), ctx({ repoId: 'r1', number: '42' }));
    expect(res.status).toBe(200);
    expect((await res.json()).files).toEqual([]);
  });

  it('returns header + latest review (stale derived) + history, parsing with the shared schema', async () => {
    const latest = {
      ...baseReview,
      issues: [
        {
          id: 'i1',
          reviewId: 'rev1',
          file: 'a.ts',
          line: 3,
          severity: 'high',
          category: 'bug',
          title: 't',
          explanation: 'e',
          suggestedFix: null,
          posted: true,
          githubCommentId: null,
          createdAt: NOW,
        },
      ],
    };
    db.review.findMany.mockResolvedValue([baseReview]);
    db.review.findFirst.mockResolvedValue(latest);
    const res = await getPull(req('/x'), ctx({ repoId: 'r1', number: '42' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const shared = GetPullResponse.parse(body);
    expect(shared.pull.htmlUrl).toBe('https://github.com/acme/web/pull/42');
    expect(shared.review?.stale).toBe(true);
    expect(shared.review?.risk).toEqual({
      score: 40,
      level: 'medium',
      factors: [{ key: 'ai', label: 'AI', points: 40 }],
    });
    expect(shared.review?.issues[0]).not.toHaveProperty('suggested_fix');
    expect(GetPullResponse.parse(body).reviews).toHaveLength(1);
  });
});

describe('GET /api/reviews/:id', () => {
  it('returns a ReviewDetail', async () => {
    db.review.findUnique.mockResolvedValue({ ...baseReview, pullRequest: { ...pull, repo } });
    db.issue.findMany.mockResolvedValue([]);
    const res = await getReview(req('/x'), ctx({ id: 'rev1' }));
    expect(ReviewDetailSchema.parse(await res.json()).id).toBe('rev1');
  });
});

// ---------------------------------------------------------------- retry / rerun

describe('POST /api/reviews/:id/retry', () => {
  it('only failed reviews can be retried (409)', async () => {
    db.review.findUnique.mockResolvedValue({ ...baseReview, pullRequest: { ...pull, repo } });
    const res = await retry(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }));
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('resets a failed job review to queued and sends review/requested with ids only', async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      status: 'failed',
      errorCode: 'timeout',
      pullRequest: { ...pull, repo },
    });
    db.review.updateMany.mockResolvedValue({ count: 1 });
    const res = await retry(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }));
    expect(res.status).toBe(202);
    expect(RetryReviewResponse.parse(await res.json())).toEqual({
      reviewId: 'rev1',
      status: 'queued',
    });
    expect(db.review.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: 'queued',
      errorCode: null,
    });
    expect(db.issue.deleteMany).toHaveBeenCalledWith({ where: { reviewId: 'rev1' } });
    expect(send).toHaveBeenCalledWith({
      name: 'review/requested',
      data: { reviewId: 'rev1', orgId: 'org1' },
    });
  });

  it('action providers go back to waiting_action without an event', async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      provider: 'claude_action',
      status: 'failed',
      pullRequest: { ...pull, repo },
    });
    db.review.updateMany.mockResolvedValue({ count: 1 });
    const res = await retry(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }));
    expect(RetryReviewResponse.parse(await res.json()).status).toBe('waiting_action');
    expect(send).not.toHaveBeenCalled();
  });

  it('marks the review failed if the event cannot be sent', async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      status: 'failed',
      pullRequest: { ...pull, repo },
    });
    db.review.updateMany.mockResolvedValue({ count: 1 });
    send.mockRejectedValue(new Error('inngest down'));
    const res = await retry(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }));
    expect(res.status).toBe(500);
    expect(db.review.update).toHaveBeenCalledWith({
      where: { id: 'rev1' },
      data: expect.objectContaining({ status: 'failed', errorCode: 'internal' }),
    });
  });
});

describe('POST /api/reviews/:id/cancel', () => {
  it('cancels a queued review atomically and sends no event', async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      status: 'queued',
      pullRequest: { ...pull, repo },
    });
    db.review.updateMany.mockResolvedValue({ count: 1 });
    const res = await cancel(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }));
    expect(res.status).toBe(200);
    expect(CancelReviewResponse.parse(await res.json())).toEqual({
      reviewId: 'rev1',
      status: 'cancelled',
    });
    expect(db.review.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'rev1', status: { in: ['queued', 'waiting_action'] } },
      data: { status: 'cancelled' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('409 when the review already started or finished', async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      status: 'running',
      pullRequest: { ...pull, repo },
    });
    db.review.updateMany.mockResolvedValue({ count: 0 });
    const res = await cancel(req('/x', { method: 'POST' }), ctx({ id: 'rev1' }));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/repos/:repoId/pulls/:number/rerun', () => {
  const call = (body?: unknown) =>
    rerun(
      req('/x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
      ctx({ repoId: 'r1', number: '42' }),
    );

  it('unknown provider → 400', async () => {
    expect((await call({ provider: 'gpt' })).status).toBe(400);
  });

  it('creates a review for the current head with the repo provider and enqueues it', async () => {
    db.review.findUnique.mockResolvedValue(null);
    db.review.create.mockResolvedValue({ id: 'new' });
    const res = await call();
    expect(res.status).toBe(202);
    expect(RerunResponse.parse(await res.json())).toEqual({ reviewId: 'new', status: 'queued' });
    expect(db.review.create.mock.calls[0]?.[0].data).toEqual({
      pullRequestId: 'p1',
      headSha: 'head2',
      provider: 'platform',
      status: 'queued',
    });
    expect(send).toHaveBeenCalledWith({
      name: 'review/requested',
      data: { reviewId: 'new', orgId: 'org1' },
    });
  });

  it('with another provider: an action provider waits for the Action', async () => {
    db.review.findUnique.mockResolvedValue(null);
    db.review.create.mockResolvedValue({ id: 'new' });
    const res = await call({ provider: 'codex_action' });
    expect(RerunResponse.parse(await res.json()).status).toBe('waiting_action');
    expect(send).not.toHaveBeenCalled();
  });

  it('reuses a finished review for the same head/provider', async () => {
    db.review.findUnique.mockResolvedValue({ ...baseReview, id: 'old', headSha: 'head2' });
    db.review.updateMany.mockResolvedValue({ count: 1 });
    const res = await call();
    expect(RerunResponse.parse(await res.json()).reviewId).toBe('old');
    expect(db.review.create).not.toHaveBeenCalled();
  });

  it('409 and keeps the result for a completed Action review (we cannot start the workflow)', async () => {
    db.review.findUnique.mockResolvedValue({
      ...baseReview,
      status: 'completed',
      provider: 'claude_action',
      headSha: 'head2',
    });
    const res = await call({ provider: 'claude_action' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/Push a new commit/);
    expect(db.review.updateMany).not.toHaveBeenCalled();
    expect(db.issue.deleteMany).not.toHaveBeenCalled();
  });

  it('409 while the same review is in progress', async () => {
    db.review.findUnique.mockResolvedValue({ ...baseReview, status: 'running', headSha: 'head2' });
    db.review.updateMany.mockResolvedValue({ count: 0 });
    const res = await call();
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('POST /api/repos/:repoId/pulls/:number/merge', () => {
  const call = (body?: unknown) =>
    merge(
      req('/x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
      ctx({ repoId: 'r1', number: '42' }),
    );
  const reviewed = { ...baseReview, headSha: 'head2' };

  beforeEach(() => {
    memberships.set('u1', new Map([['org1', 'admin']]));
    db.review.findFirst.mockResolvedValue(reviewed);
    db.installation.findUnique.mockResolvedValue({ id: 'inst1', githubInstallationId: 99 });
    gh.getInstallationOctokit.mockResolvedValue(gh.octokit);
    gh.mergePullRequest.mockResolvedValue({ sha: 'mergeSha' });
  });

  it('a plain member cannot merge (403)', async () => {
    memberships.set('u1', new Map([['org1', 'member']]));
    const res = await call();
    expect(res.status).toBe(403);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it("cannot merge another org's PR (403)", async () => {
    const res = await merge(req('/x', { method: 'POST' }), ctx({ repoId: 'r2', number: '42' }));
    expect(res.status).toBe(403);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('unknown method → 400', async () => {
    expect((await call({ method: 'octopus' })).status).toBe(400);
  });

  it('merges the reviewed head with the installation token and marks the PR merged', async () => {
    const res = await call({ method: 'squash' });
    expect(res.status).toBe(200);
    expect(MergeResponse.parse(await res.json())).toEqual({ merged: true, sha: 'mergeSha' });
    expect(gh.getInstallationOctokit).toHaveBeenCalledWith(99);
    expect(gh.mergePullRequest).toHaveBeenCalledWith(gh.octokit, 'acme', 'web', 42, {
      sha: 'head2',
      method: 'squash',
    });
    expect(db.pullRequest.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { state: 'merged' },
    });
  });

  it('defaults to a merge commit', async () => {
    await call();
    expect(gh.mergePullRequest.mock.calls[0]?.[4]).toEqual({ sha: 'head2', method: 'merge' });
  });

  it.each([
    ['no review', null],
    ['a review of an older commit', { ...baseReview, headSha: 'head1' }],
    ['a review still running', { ...reviewed, status: 'running' }],
    ['a failed review', { ...reviewed, status: 'failed' }],
  ])('409 with %s', async (_name, latest) => {
    db.review.findFirst.mockResolvedValue(latest);
    const res = await call();
    expect(res.status).toBe(409);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409 when the PR is not open', async () => {
    db.pullRequest.findUnique.mockResolvedValue({ ...pull, state: 'closed' });
    expect((await call()).status).toBe(409);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['not_mergeable', 409, /Required status check/],
    ['head_changed', 409, /branch changed/],
    ['forbidden', 403, /Contents: Read & write/],
    ['not_found', 404, /not found/],
  ] as const)('GitHub %s → %i', async (reason, status, message) => {
    gh.mergePullRequest.mockRejectedValue(
      new MergeError(reason, 'Required status check "ci" is expected.'),
    );
    const res = await call();
    expect(res.status).toBe(status);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toMatch(message);
    expect(db.pullRequest.update).not.toHaveBeenCalled();
  });

  it('other GitHub failures → 500 without details', async () => {
    gh.mergePullRequest.mockRejectedValue(new Error('socket hang up'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe('internal');
  });
});

// ---------------------------------------------------------------- settings + tokens

describe('settings', () => {
  it('GET returns defaults applied', async () => {
    const res = await getSettings(req('/x'), ctx({ repoId: 'r1' }));
    const body = GetRepoSettingsResponse.parse(await res.json());
    expect(body.settings.maxIssuesPerPr).toBe(30);
    expect(body.hasIngestToken).toBe(false);
  });

  it('PUT requires owner/admin', async () => {
    const res = await putSettings(
      req('/x', { method: 'PUT', body: JSON.stringify({ provider: 'platform', settings: {} }) }),
      ctx({ repoId: 'r1' }),
    );
    expect(res.status).toBe(403);
    expect(db.repo.update).not.toHaveBeenCalled();
  });

  it('PUT validates the body (400) and saves', async () => {
    memberships.get('u1')!.set('org1', 'admin');
    const bad = await putSettings(
      req('/x', { method: 'PUT', body: '{"provider":"gpt"}' }),
      ctx({ repoId: 'r1' }),
    );
    expect(bad.status).toBe(400);
    const malformed = await putSettings(
      req('/x', { method: 'PUT', body: '{' }),
      ctx({ repoId: 'r1' }),
    );
    expect(malformed.status).toBe(400);

    db.repo.update.mockImplementation(async ({ data }: { data: object }) => ({ ...repo, ...data }));
    const ok = await putSettings(
      req('/x', {
        method: 'PUT',
        body: JSON.stringify({ provider: 'claude_action', settings: { minSeverity: 'high' } }),
      }),
      ctx({ repoId: 'r1' }),
    );
    expect(ok.status).toBe(200);
    const body = GetRepoSettingsResponse.parse(await ok.json());
    expect(body).toMatchObject({
      provider: 'claude_action',
      settings: { minSeverity: 'high', maxIssuesPerPr: 30 },
    });
  });

  it('rotate stores only the hash and returns the token once', async () => {
    memberships.get('u1')!.set('org1', 'owner');
    const res = await rotate(req('/x', { method: 'POST' }), ctx({ repoId: 'r1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { token } = RotateIngestTokenResponse.parse(await res.json());
    expect(db.repo.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { ingestTokenHash: hashToken(token) },
    });
    expect(JSON.stringify(db.repo.update.mock.calls)).not.toContain(token);
  });

  it('rotate requires owner/admin', async () => {
    const res = await rotate(req('/x', { method: 'POST' }), ctx({ repoId: 'r1' }));
    expect(res.status).toBe(403);
  });

  it('workflow PR renders the YAML and opens the PR with the installation octokit', async () => {
    memberships.get('u1')!.set('org1', 'admin');
    db.installation.findUnique.mockResolvedValue({ id: 'inst1', githubInstallationId: 7 });
    gh.getInstallationOctokit.mockResolvedValue(gh.octokit);
    gh.renderWorkflow.mockReturnValue('name: ai-review');
    gh.openWorkflowPR.mockResolvedValue({
      prNumber: 5,
      prUrl: 'https://github.com/acme/web/pull/5',
    });
    const res = await workflowPr(
      req('/x', { method: 'POST', body: JSON.stringify({ provider: 'claude_action' }) }),
      ctx({ repoId: 'r1' }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ prNumber: 5, prUrl: 'https://github.com/acme/web/pull/5' });
    expect(gh.getInstallationOctokit).toHaveBeenCalledWith(7);
    expect(gh.renderWorkflow).toHaveBeenCalledWith('claude_action', {
      publicUrl: process.env.PUBLIC_URL,
    });
    expect(gh.openWorkflowPR).toHaveBeenCalledWith(
      gh.octokit,
      'acme/web',
      'claude_action',
      'name: ai-review',
    );
  });
});

// ---------------------------------------------------------------- overview + connections

describe('GET /api/orgs/:orgId/overview', () => {
  it('invalid range → 400', async () => {
    const res = await overview(req('/x?range=7d'), ctx({ orgId: 'org1' }));
    expect(res.status).toBe(400);
  });
});

describe('/api/connections/chatgpt', () => {
  it('GET reports the connection without returning tokens', async () => {
    db.providerCredential.findUnique.mockResolvedValue({ createdAt: NOW, expiresAt: null });
    const res = await getConn(req('/x'), ctx({}));
    const body = await res.json();
    expect(body).toEqual({
      connected: true,
      orgId: 'org1',
      connectedAt: NOW.toISOString(),
      expiresAt: null,
    });
    expect(db.providerCredential.findUnique.mock.calls[0]?.[0].select).toEqual({
      createdAt: true,
      expiresAt: true,
    });
  });

  it("DELETE removes only the user's own credential in the current org", async () => {
    const res = await deleteConn(req('/x', { method: 'DELETE' }), ctx({}));
    expect(await res.json()).toEqual({ ok: true });
    expect(db.providerCredential.deleteMany).toHaveBeenCalledWith({
      where: { orgId: 'org1', userId: 'u1', provider: 'codex_chatgpt' },
    });
  });
});

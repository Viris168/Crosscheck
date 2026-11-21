import { ProviderError } from '@app/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ciBucket,
  createOctokit,
  fetchCiState,
  gitAuthForInstallation,
  listBranches,
  listPullRequestsForTree,
  resetGithubClients,
  resetTreeWarningsForTesting,
} from './index';

const API = 'https://api.github.com';
const REPO = `${API}/repos/acme/web`;
const SHA = 'a'.repeat(40);

// ---------------------------------------------------------------- no-compare guard

/**
 * The tree must never call GitHub's compare API. This handler sits in the server's initial handlers
 * (kept across `resetHandlers`), answers 500 and records the hit; `afterEach` fails the test on any hit.
 */
function noCompareGuard() {
  const hits: string[] = [];
  const handler = http.all(/\/compare\//, ({ request }) => {
    hits.push(request.url);
    return HttpResponse.json({ message: 'compare API is forbidden in tests' }, { status: 500 });
  });
  return { handler, hits };
}

const guard = noCompareGuard();
const server = setupServer(guard.handler);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetTreeWarningsForTesting());
afterEach(() => {
  server.resetHandlers();
  resetGithubClients();
  const hits = guard.hits.splice(0);
  expect(hits, 'compare API must never be called').toEqual([]);
});
afterAll(() => server.close());

const TOKEN = 'ghs_SECRETtoken123';
const octokit = () =>
  createOctokit({ auth: TOKEN, retry: { enabled: false }, throttle: { enabled: false } });

async function caught(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('no-compare guard', () => {
  it('catches a compare call', async () => {
    const res = await fetch(`${REPO}/compare/main...feat`);
    expect(res.status).toBe(500);
    expect(guard.hits.splice(0)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- listBranches

describe('listBranches', () => {
  const branch = (i: number) => ({
    name: `b${i}`,
    commit: { sha: i.toString(16).padStart(40, '0'), url: 'x' },
    protected: i === 0,
  });

  it('paginates and returns the default branch', async () => {
    const pages: number[] = [];
    server.use(
      http.get(REPO, () => HttpResponse.json({ default_branch: 'develop' })),
      http.get(`${REPO}/branches`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('per_page')).toBe('100');
        const page = Number(url.searchParams.get('page'));
        pages.push(page);
        const count = page < 3 ? 100 : 7;
        return HttpResponse.json(
          Array.from({ length: count }, (_, i) => branch((page - 1) * 100 + i)),
        );
      }),
    );
    const res = await listBranches(octokit(), 'acme/web');
    expect(pages).toEqual([1, 2, 3]);
    expect(res.defaultBranch).toBe('develop');
    expect(res.branches).toHaveLength(207);
    expect(res.branches[0]).toEqual({ name: 'b0', headSha: '0'.repeat(40), protected: true });
    expect(res.branches[206]).toEqual({
      name: 'b206',
      headSha: (206).toString(16).padStart(40, '0'),
      protected: false,
    });
  });

  it('stops on an empty page after a full one', async () => {
    let calls = 0;
    server.use(
      http.get(REPO, () => HttpResponse.json({ default_branch: 'main' })),
      http.get(`${REPO}/branches`, ({ request }) => {
        calls++;
        const page = Number(new URL(request.url).searchParams.get('page'));
        return HttpResponse.json(
          page === 1 ? Array.from({ length: 100 }, (_, i) => branch(i)) : [],
        );
      }),
    );
    expect((await listBranches(octokit(), 'acme/web')).branches).toHaveLength(100);
    expect(calls).toBe(2);
  });

  it('maps failures to github_error without the token', async () => {
    server.use(
      http.get(REPO, () => HttpResponse.json({ default_branch: 'main' })),
      http.get(`${REPO}/branches`, () => HttpResponse.json({ message: 'boom' }, { status: 502 })),
    );
    const err = await caught(listBranches(octokit(), 'acme/web'));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'github_error' });
    expect(err.message).toContain('502');
    expect(err.message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------- listPullRequestsForTree

function pr(n: number, extra: Record<string, unknown> = {}) {
  return {
    number: n,
    state: 'open',
    title: `PR ${n}`,
    user: { login: 'octo' },
    head: { ref: `feat-${n}`, sha: 'b'.repeat(40) },
    base: { ref: 'main', sha: 'c'.repeat(40) },
    merged_at: null,
    merge_commit_sha: 'd'.repeat(40),
    updated_at: '2026-11-01T00:00:00Z',
    ...extra,
  };
}

describe('listPullRequestsForTree', () => {
  it('asks for all PRs, newest first, and paginates until a short page', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(`${REPO}/pulls`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        seen.push(q);
        const page = Number(q.get('page'));
        const count = page === 1 ? 100 : 3;
        return HttpResponse.json(
          Array.from({ length: count }, (_, i) => pr(1000 - (page - 1) * 100 - i)),
        );
      }),
    );
    const prs = await listPullRequestsForTree(octokit(), 'acme/web');
    expect(prs).toHaveLength(103);
    expect(prs[0]?.number).toBe(1000);
    expect(seen.map((q) => q.get('page'))).toEqual(['1', '2']);
    for (const q of seen) {
      expect(q.get('state')).toBe('all');
      expect(q.get('sort')).toBe('created');
      expect(q.get('direction')).toBe('desc');
      expect(q.get('per_page')).toBe('100');
    }
  });

  it('stops after maxPages (default 10)', async () => {
    let calls = 0;
    server.use(
      http.get(`${REPO}/pulls`, () => {
        calls++;
        return HttpResponse.json(Array.from({ length: 100 }, (_, i) => pr(i + 1)));
      }),
    );
    expect(await listPullRequestsForTree(octokit(), 'acme/web')).toHaveLength(1000);
    expect(calls).toBe(10);

    calls = 0;
    expect(await listPullRequestsForTree(octokit(), 'acme/web', { maxPages: 2 })).toHaveLength(200);
    expect(calls).toBe(2);
  });

  it('maps state: merged_at set → merged, closed, open', async () => {
    server.use(
      http.get(`${REPO}/pulls`, () =>
        HttpResponse.json([
          pr(3, {
            state: 'closed',
            merged_at: '2026-11-02T10:00:00Z',
            merge_commit_sha: 'e'.repeat(40),
          }),
          pr(2, { state: 'closed', merge_commit_sha: null }),
          pr(1, { user: null }),
        ]),
      ),
    );
    const prs = await listPullRequestsForTree(octokit(), 'acme/web');
    expect(prs.map((p) => p.state)).toEqual(['merged', 'closed', 'open']);
    expect(prs[0]).toEqual({
      number: 3,
      state: 'merged',
      headRef: 'feat-3',
      headSha: 'b'.repeat(40),
      baseRef: 'main',
      baseSha: 'c'.repeat(40),
      mergedAt: '2026-11-02T10:00:00Z',
      mergeCommitSha: 'e'.repeat(40),
      title: 'PR 3',
      author: 'octo',
      updatedAt: '2026-11-01T00:00:00Z',
    });
    expect(prs[1]?.mergeCommitSha).toBeNull();
    expect(prs[1]?.mergedAt).toBeNull();
    expect(prs[2]?.author).toBe('ghost');
  });

  it('maps failures to github_error', async () => {
    server.use(
      http.get(`${REPO}/pulls`, () => HttpResponse.json({ message: 'x' }, { status: 404 })),
    );
    await expect(listPullRequestsForTree(octokit(), 'acme/web')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'github_error',
    });
  });
});

// ---------------------------------------------------------------- fetchCiState

type Run = { status: string; conclusion: string | null };

function ciHandlers(runs: Run[] | 403, statuses: string[] | 403) {
  return [
    http.get(`${REPO}/commits/${SHA}/check-runs`, () =>
      runs === 403
        ? HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 })
        : HttpResponse.json({ total_count: runs.length, check_runs: runs }),
    ),
    http.get(`${REPO}/commits/${SHA}/status`, () =>
      statuses === 403
        ? HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 })
        : HttpResponse.json({
            state: 'pending',
            total_count: statuses.length,
            statuses: statuses.map((state, i) => ({ state, context: `ctx${i}` })),
          }),
    ),
  ];
}

const done = (conclusion: string): Run => ({ status: 'completed', conclusion });
const running = (status: string): Run => ({ status, conclusion: null });

describe('fetchCiState', () => {
  // Every row of the T-spec "CI state" table, from check runs, statuses, or both.
  it.each<[string, Run[], string[], string]>([
    ['nothing', [], [], 'none'],
    ['check failure', [done('success'), done('failure')], [], 'failure'],
    ['check cancelled', [done('cancelled')], ['success'], 'failure'],
    ['check timed_out', [done('timed_out')], [], 'failure'],
    ['status error', [done('success')], ['error'], 'failure'],
    ['status failure', [], ['failure', 'pending'], 'failure'],
    ['failure beats pending', [running('in_progress')], ['failure'], 'failure'],
    ['check queued', [running('queued'), done('success')], [], 'pending'],
    ['check in_progress', [running('in_progress')], [], 'pending'],
    ['status pending', [done('success')], ['pending'], 'pending'],
    ['pending beats success', [done('success')], ['success', 'pending'], 'pending'],
    ['all success', [done('success')], ['success'], 'success'],
    ['success with neutral/skipped', [done('neutral'), done('skipped')], ['success'], 'success'],
    ['only neutral', [done('neutral')], [], 'neutral'],
    ['only skipped', [done('skipped')], [], 'neutral'],
    ['neutral + skipped', [done('neutral'), done('skipped')], [], 'neutral'],
  ])('%s → %s', async (_name, runs, statuses, expected) => {
    server.use(...ciHandlers(runs, statuses));
    const res = await fetchCiState(octokit(), 'acme/web', SHA);
    expect(res.state).toBe(expected);
    const total = res.counts.success + res.counts.failure + res.counts.pending + res.counts.neutral;
    expect(total).toBe(runs.length + statuses.length);
  });

  it('counts by bucket', async () => {
    server.use(
      ...ciHandlers(
        [done('success'), done('failure'), running('queued'), done('skipped')],
        ['success', 'error'],
      ),
    );
    expect((await fetchCiState(octokit(), 'acme/web', SHA)).counts).toEqual({
      success: 2,
      failure: 2,
      pending: 1,
      neutral: 1,
    });
  });

  it('paginates check runs', async () => {
    const pages: string[] = [];
    server.use(
      http.get(`${REPO}/commits/${SHA}/check-runs`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')!;
        pages.push(page);
        const runs =
          page === '1' ? Array.from({ length: 100 }, () => done('success')) : [done('failure')];
        return HttpResponse.json({ total_count: 101, check_runs: runs });
      }),
      ciHandlers([], [])[1]!,
    );
    const res = await fetchCiState(octokit(), 'acme/web', SHA);
    expect(pages).toEqual(['1', '2']);
    expect(res).toEqual({
      state: 'failure',
      counts: { success: 100, failure: 1, pending: 0, neutral: 0 },
    });
  });

  it('403 on statuses → statuses empty, logged once per repo', async () => {
    const warn = vi.fn();
    server.use(...ciHandlers([done('success')], 403));
    expect(await fetchCiState(octokit(), 'acme/web', SHA, { warn })).toEqual({
      state: 'success',
      counts: { success: 1, failure: 0, pending: 0, neutral: 0 },
    });
    await fetchCiState(octokit(), 'acme/web', SHA, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { fullName: 'acme/web', reason: 'statuses_forbidden' },
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('403 on checks → checks empty, logged once', async () => {
    const warn = vi.fn();
    server.use(...ciHandlers(403, ['pending']));
    expect((await fetchCiState(octokit(), 'acme/web', SHA, { warn })).state).toBe('pending');
    await fetchCiState(octokit(), 'acme/web', SHA, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { fullName: 'acme/web', reason: 'checks_forbidden' },
      expect.any(String),
    );
  });

  it('403 on both → none', async () => {
    const warn = vi.fn();
    server.use(...ciHandlers(403, 403));
    expect((await fetchCiState(octokit(), 'acme/web', SHA, { warn })).state).toBe('none');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('other failures → github_error', async () => {
    server.use(
      ciHandlers([], [])[0]!,
      http.get(`${REPO}/commits/${SHA}/status`, () =>
        HttpResponse.json({ message: 'x' }, { status: 500 }),
      ),
    );
    const err = await caught(fetchCiState(octokit(), 'acme/web', SHA));
    expect(err).toMatchObject({ code: 'github_error' });
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('ciBucket', () => {
  it('maps every known value', () => {
    expect(
      ['failure', 'cancelled', 'timed_out', 'error', 'action_required', 'startup_failure'].map(
        ciBucket,
      ),
    ).toEqual(Array(6).fill('failure'));
    expect(['queued', 'in_progress', 'pending', 'waiting', 'requested'].map(ciBucket)).toEqual(
      Array(5).fill('pending'),
    );
    expect(ciBucket('success')).toBe('success');
    expect(['neutral', 'skipped', 'stale'].map(ciBucket)).toEqual(Array(3).fill('neutral'));
    expect(ciBucket(null)).toBe('pending');
    expect(ciBucket('something_new')).toBe('pending');
  });
});

// ---------------------------------------------------------------- gitAuthForInstallation

describe('gitAuthForInstallation', () => {
  const tokenUrl = `${API}/app/installations/42/access_tokens`;
  const appOctokit = () =>
    createOctokit({ auth: 'app-jwt', retry: { enabled: false }, throttle: { enabled: false } });

  it('scopes the token to one repo and puts it only in the extraheader env', async () => {
    let body: unknown;
    server.use(
      http.post(tokenUrl, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { token: TOKEN, expires_at: '2026-11-21T13:00:00Z', permissions: {} },
          { status: 201 },
        );
      }),
    );
    const auth = await gitAuthForInstallation(
      42,
      { githubRepoId: 777, fullName: 'acme/web' },
      {
        appOctokit: appOctokit(),
      },
    );
    expect(body).toEqual({
      repository_ids: [777],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(auth.url).toBe('https://github.com/acme/web.git');
    expect(auth.url).not.toContain(TOKEN);
    expect(auth.url).not.toContain('@');
    expect(auth.expiresAt).toEqual(new Date('2026-11-21T13:00:00Z'));
    expect(auth.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    });
  });

  it('uses the App JWT client by default', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    vi.stubEnv('GITHUB_APP_ID', '123');
    vi.stubEnv(
      'GITHUB_APP_PRIVATE_KEY',
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    );
    let authHeader: string | null = null;
    server.use(
      http.post(tokenUrl, ({ request }) => {
        authHeader = request.headers.get('authorization');
        return HttpResponse.json(
          { token: TOKEN, expires_at: '2026-11-21T13:00:00Z' },
          { status: 201 },
        );
      }),
    );
    try {
      await gitAuthForInstallation(42, { githubRepoId: 1, fullName: 'acme/web' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(authHeader).toMatch(/^bearer /i);
  });

  it('throws github_error without the token or the response body', async () => {
    server.use(
      http.post(tokenUrl, () => HttpResponse.json({ message: `bad ${TOKEN}` }, { status: 422 })),
    );
    const err = await caught(
      gitAuthForInstallation(
        42,
        { githubRepoId: 1, fullName: 'acme/web' },
        { appOctokit: appOctokit() },
      ),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'github_error' });
    expect(err.message).toContain('422');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('app-jwt');
  });

  it('rejects a bad full name before calling GitHub', async () => {
    await expect(
      gitAuthForInstallation(
        42,
        { githubRepoId: 1, fullName: 'nope' },
        { appOctokit: appOctokit() },
      ),
    ).rejects.toThrow(/Invalid repository full name/);
  });
});

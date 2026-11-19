/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory Prisma stand-in */
import { hashToken, type ReviewResult } from '@app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- in-memory db

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  t: { repo: [] as Row[], pullRequest: [] as Row[], review: [] as Row[], issue: [] as Row[] },
  send: vi.fn(async (_e: unknown) => ({ ids: ['evt'] })),
  redis: new Map<string, number>(),
  redisDown: { value: false },
  seq: 0,
}));

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
    return (row[k] ?? null) === v;
  });

const pickSel = (row: Row | undefined, select?: Row) =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : row;

const db: any = {
  repo: {
    findUnique: async ({ where, select }: any) =>
      pickSel(
        h.t.repo.find((r) => r.ingestTokenHash === where.ingestTokenHash),
        select,
      ),
  },
  pullRequest: {
    findUnique: async ({ where, select }: any) => {
      const k = where.repoId_number;
      return pickSel(
        h.t.pullRequest.find((p) => p.repoId === k.repoId && p.number === k.number),
        select,
      );
    },
  },
  review: {
    findMany: async ({ where, select }: any) =>
      h.t.review
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => pickSel(r, select)),
    findUnique: async ({ where, select }: any) =>
      pickSel(
        h.t.review.find((r) => r.id === where.id),
        select,
      ),
    updateMany: async ({ where, data }: any) => {
      const hits = h.t.review.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    },
    update: async ({ where, data }: any) =>
      Object.assign(h.t.review.find((r) => r.id === where.id)!, data),
  },
  issue: {
    deleteMany: async ({ where }: any) => {
      const before = h.t.issue.length;
      h.t.issue = h.t.issue.filter((i) => i.reviewId !== where.reviewId);
      return { count: before - h.t.issue.length };
    },
    createMany: async ({ data }: any) => {
      h.t.issue.push(...data.map((d: Row) => ({ id: `iss_${++h.seq}`, ...d })));
      return { count: data.length };
    },
  },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

vi.mock('@app/db', () => ({ prisma: db }));
vi.mock('@/server/jobs', () => ({ inngest: { send: h.send } }));
vi.mock('@/server/github', () => ({
  requestReview: vi.fn(async (input: any) => {
    const row = {
      id: `rev_${++h.seq}`,
      pullRequestId: input.pullRequestId,
      headSha: input.headSha,
      provider: input.provider,
      status: 'waiting_action',
      errorCode: null,
      startedAt: null,
      createdAt: Date.now(),
    };
    h.t.review.push(row);
    return { created: true, reviewId: row.id, status: row.status };
  }),
}));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    incr: async (key: string) => {
      if (h.redisDown.value) throw new Error('ECONNREFUSED');
      const n = (h.redis.get(key) ?? 0) + 1;
      h.redis.set(key, n);
      return n;
    },
    expire: async () => 1,
  }),
}));
vi.mock('@/server/logger', () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { logger };
});

const { handleIngestReview, INGEST_RATE_LIMIT } = await import('./index');

// ---------------------------------------------------------------- fixtures

const TOKEN = 'rit_test-token-123';
const SHA = 'a'.repeat(40);
const URL_ = 'http://localhost/api/ingest/review';

function seed() {
  h.t.repo = [
    {
      id: 'repo_1',
      orgId: 'org_1',
      fullName: 'acme/web',
      provider: 'claude_action',
      active: true,
      ingestTokenHash: hashToken(TOKEN),
    },
  ];
  h.t.pullRequest = [
    { id: 'pr_1', repoId: 'repo_1', number: 7, state: 'open', headSha: SHA, changedFiles: 4 },
  ];
  h.t.review = [
    {
      id: 'rev_1',
      pullRequestId: 'pr_1',
      headSha: SHA,
      provider: 'claude_action',
      status: 'waiting_action',
      errorCode: null,
      startedAt: null,
      createdAt: 1,
    },
  ];
  h.t.issue = [];
}

const result = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  schema_version: 1,
  repo: 'acme/web',
  pr_number: 7,
  head_sha: SHA,
  risk_score: 40,
  summary: 'Looks mostly fine.',
  issues: [
    {
      file: 'src/a.ts',
      line: 3,
      severity: 'high',
      category: 'bug',
      title: 'Off by one',
      explanation: 'Loop runs one time too many.',
    },
  ],
  ...over,
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleIngestReview(
    new Request(URL_, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  seed();
  h.send.mockClear();
  h.send.mockImplementation(async () => ({ ids: ['evt'] }));
  h.redis.clear();
  h.redisDown.value = false;
});

// ---------------------------------------------------------------- tests

describe('POST /api/ingest/review', () => {
  it('valid result → 202, issues saved, review/finalize sent', async () => {
    const res = await post(result());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ reviewId: 'rev_1', duplicate: false });
    expect(h.send).toHaveBeenCalledWith({ name: 'review/finalize', data: { reviewId: 'rev_1' } });
    const review = h.t.review[0]!;
    expect(review).toMatchObject({
      filesTotal: 4,
      filesDone: 4,
      summary: 'Looks mostly fine.',
      aiRiskScore: 40,
    });
    expect(review.startedAt).toBeInstanceOf(Date);
    expect(review.status).toBe('waiting_action'); // finalize completes it
    expect(h.t.issue).toHaveLength(1);
    expect(h.t.issue[0]).toMatchObject({ reviewId: 'rev_1', file: 'src/a.ts', suggestedFix: null });
  });

  it('event payload carries ids only', async () => {
    await post(result());
    const event = h.send.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.keys(event.data)).toEqual(['reviewId']);
  });

  it('bad token → 401', async () => {
    const res = await post(result(), { authorization: 'Bearer rit_wrong' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
  });

  it('missing / non-rit token → 401', async () => {
    expect((await post(result(), { authorization: '' })).status).toBe(401);
    expect((await post(result(), { authorization: 'Bearer ghp_abc' })).status).toBe(401);
  });

  it('inactive repo → 401', async () => {
    h.t.repo[0]!.active = false;
    expect((await post(result())).status).toBe(401);
  });

  it('wrong repo → 409', async () => {
    const res = await post(result({ repo: 'acme/other' }));
    expect(res.status).toBe(409);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('repo name compare is case-insensitive', async () => {
    expect((await post(result({ repo: 'ACME/Web' }))).status).toBe(202);
  });

  it('closed or unknown PR → 409', async () => {
    expect((await post(result({ pr_number: 99 }))).status).toBe(409);
    h.t.pullRequest[0]!.state = 'closed';
    expect((await post(result())).status).toBe(409);
  });

  it('stale sha (no review, not the PR head) → 409', async () => {
    const res = await post(result({ head_sha: 'b'.repeat(40) }));
    expect(res.status).toBe(409);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('no review yet but sha is the PR head → creates one and accepts', async () => {
    h.t.review = [];
    const res = await post(result());
    expect(res.status).toBe(202);
    expect(h.t.review).toHaveLength(1);
    expect(h.t.review[0]).toMatchObject({ provider: 'claude_action', headSha: SHA });
  });

  it('no review and repo is not on an Action provider → 409', async () => {
    h.t.review = [];
    h.t.repo[0]!.provider = 'platform';
    expect((await post(result())).status).toBe(409);
  });

  it('review not waiting (e.g. cancelled / timed out) → 409', async () => {
    h.t.review[0]!.status = 'cancelled';
    expect((await post(result())).status).toBe(409);
  });

  it('duplicate submit → 200 { duplicate: true }, no second event, no duplicate issues', async () => {
    expect((await post(result())).status).toBe(202);
    const res = await post(result());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reviewId: 'rev_1', duplicate: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.t.issue).toHaveLength(1);
  });

  it('duplicate after finalize completed → 200', async () => {
    await post(result());
    h.t.review[0]!.status = 'completed';
    expect((await post(result())).status).toBe(200);
  });

  it('event send failure → 500 and the claim is undone so a retry works', async () => {
    h.send.mockRejectedValueOnce(new Error('inngest down'));
    const res = await post(result());
    expect(res.status).toBe(500);
    expect(h.t.review[0]!.startedAt).toBeNull();
    expect(h.t.issue).toHaveLength(0);
    expect((await post(result())).status).toBe(202);
  });

  it('oversize Content-Length → 413', async () => {
    const res = await post(result(), { 'content-length': String(2_000_000) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
  });

  it('oversize streamed body without Content-Length → 413', async () => {
    const big = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 1_100_000) return c.close();
        sent += big.byteLength;
        c.enqueue(big);
      },
    });
    const res = await handleIngestReview(
      new Request(URL_, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: stream,
        // @ts-expect-error -- Node fetch needs duplex for streamed bodies
        duplex: 'half',
      }),
    );
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(1_200_000);
  });

  it('schema-invalid body → 400', async () => {
    const res = await post({ ...result(), schema_version: 2 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('malformed JSON → 400', async () => {
    expect((await post('{not json')).status).toBe(400);
  });

  it('rate limit: request 31 in an hour → 429', async () => {
    for (let i = 0; i < INGEST_RATE_LIMIT; i++) {
      expect((await post(result())).status).not.toBe(429);
    }
    const res = await post(result());
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('rate_limited');
  });

  it('rate limit key uses the token hash, never the token', async () => {
    await post(result());
    const keys = [...h.redis.keys()];
    expect(keys.some((k) => k.includes(hashToken(TOKEN)))).toBe(true);
    expect(keys.some((k) => k.includes(TOKEN))).toBe(false);
  });

  it('Redis down → request still processed', async () => {
    h.redisDown.value = true;
    expect((await post(result())).status).toBe(202);
  });

  it('no_output → review failed / invalid_output, no finalize', async () => {
    const res = await post({ error: 'no_output', repo: 'acme/web', pr_number: 7, head_sha: SHA });
    expect(res.status).toBe(200);
    expect(h.t.review[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_output' });
    expect(h.send).not.toHaveBeenCalled();
    // idempotent
    const again = await post({ error: 'no_output', pr_number: 7, head_sha: SHA });
    expect(await again.json()).toEqual({ reviewId: 'rev_1', duplicate: true });
  });

  it('no_output without identifiers → 400', async () => {
    expect((await post({ error: 'no_output' })).status).toBe(400);
  });
});

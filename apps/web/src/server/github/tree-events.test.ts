/* eslint-disable @typescript-eslint/no-explicit-any -- fixture payloads are mutated freely in tests */
import { signWebhookBody } from '@app/github';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './__fixtures__/fake-db';

// ---------------------------------------------------------------- mocks

const h = vi.hoisted(() => {
  const state: { fake?: { db: unknown } } = {};
  const redisStore = new Map<string, string>();
  return {
    state,
    redisStore,
    redisDown: { value: false },
    send: vi.fn(async (_evt: unknown) => ({ ids: ['evt'] })),
  };
});

vi.mock('@app/db', () => ({
  prisma: new Proxy(
    {},
    { get: (_t, k) => (h.state.fake!.db as Record<string, unknown>)[k as string] },
  ),
}));
vi.mock('@/server/jobs', () => ({ inngest: { send: h.send } }));
vi.mock('./membership', () => ({ syncUserMemberships: vi.fn() }));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => {
      if (h.redisDown.value) throw new Error('ECONNREFUSED');
      if (h.redisStore.has(key)) return null;
      h.redisStore.set(key, value);
      return 'OK';
    },
    del: async (key: string) => (h.redisStore.delete(key) ? 1 : 0),
  }),
}));
vi.mock('@/server/logger', () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { logger };
});

const SECRET = 'test-webhook-secret';
vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);

const { handleGithubWebhook } = await import('./index');

// ---------------------------------------------------------------- helpers

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'));

let deliverySeq = 0;

async function deliver(event: string, payload: unknown, delivery = `tree-${++deliverySeq}`) {
  const raw = JSON.stringify(payload);
  const res = await handleGithubWebhook(
    new Request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': signWebhookBody(raw, SECRET),
      },
      body: raw,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const F = 'f'.repeat(40);

let fake: FakeDb;

/** Events sent with a given name. */
const sent = (name: string) =>
  (h.send.mock.calls as unknown as [{ id?: string; name: string; data: any }][])
    .map(([evt]) => evt)
    .filter((evt) => evt.name === name);

beforeEach(() => {
  fake = createFakeDb();
  h.state.fake = fake;
  h.redisStore.clear();
  h.redisDown.value = false;
  h.send.mockReset().mockResolvedValue({ ids: ['evt'] });
  fake.tables.organization.push({ id: 'org1', slug: 'acme', githubAccountLogin: 'Acme' });
  fake.tables.repo.push({
    id: 'repo1',
    orgId: 'org1',
    githubRepoId: 2001,
    fullName: 'Acme/web',
    provider: 'platform',
    settings: {},
    active: true,
  });
});

// ---------------------------------------------------------------- push

describe('push', () => {
  it('records a push and sends tree/refs-changed with ids only', async () => {
    const r = await deliver('push', fixture('push'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, handled: true, note: 'push' });
    expect(fake.tables.gitEvent).toEqual([
      expect.objectContaining({
        repoId: 'repo1',
        kind: 'push',
        ref: 'main',
        before: D,
        after: E,
        prNumber: null,
      }),
    ]);
    const [evt] = sent('tree/refs-changed');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(evt).toEqual({
      id: `tree-refs-changed-${fake.tables.gitEvent[0]!.id}`,
      name: 'tree/refs-changed',
      data: { repoId: 'repo1', orgId: 'org1', eventId: fake.tables.gitEvent[0]!.id },
    });
  });

  it.each([
    ['push.created', 'branch_created', null, D],
    ['push.deleted', 'branch_deleted', D, null],
    ['push.forced', 'force_push', D, F],
  ])('%s → %s (zero SHA stored as null)', async (name, kind, before, after) => {
    await deliver('push', fixture(name));
    expect(fake.tables.gitEvent).toEqual([
      expect.objectContaining({ kind, ref: 'feat/login', before, after }),
    ]);
    expect(sent('tree/refs-changed')).toHaveLength(1);
  });

  it('ignores tag pushes and other non-branch refs', async () => {
    const tag = await deliver('push', fixture('push.tag'));
    expect(tag.body).toMatchObject({ handled: false, note: 'tag push' });

    const notes = fixture('push');
    notes.ref = 'refs/notes/commits';
    expect((await deliver('push', notes)).body.handled).toBe(false);

    expect(fake.tables.gitEvent).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('ignores unknown and inactive repos', async () => {
    const other = fixture('push');
    other.repository.id = 9999;
    expect((await deliver('push', other)).body).toMatchObject({ handled: false });

    fake.tables.repo[0]!.active = false;
    expect((await deliver('push', fixture('push'))).body).toMatchObject({ handled: false });

    expect(fake.tables.gitEvent).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a duplicate delivery makes one GitEvent, even with Redis dedupe down', async () => {
    h.redisDown.value = true;
    await deliver('push', fixture('push'), 'dup-1');
    const again = await deliver('push', fixture('push'), 'dup-1');
    expect(again.status).toBe(200);
    expect(fake.tables.gitEvent).toHaveLength(1);
    // Re-sent with the same id, so Inngest drops the repeat.
    const ids = sent('tree/refs-changed').map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('a duplicate delivery with Redis up is dropped before the handler', async () => {
    await deliver('push', fixture('push'), 'dup-2');
    const again = await deliver('push', fixture('push'), 'dup-2');
    expect(again.body.duplicate).toBe(true);
    expect(fake.tables.gitEvent).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('send failure → 500, delivery released; the redelivery reuses the row and sends', async () => {
    h.send.mockRejectedValueOnce(new Error('inngest down'));
    const first = await deliver('push', fixture('push'), 'retry-1');
    expect(first.status).toBe(500);
    const second = await deliver('push', fixture('push'), 'retry-1');
    expect(second.status).toBe(200);
    expect(fake.tables.gitEvent).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('rejects a push payload missing the fields we need with 400', async () => {
    const bad = fixture('push');
    delete bad.forced;
    expect((await deliver('push', bad)).status).toBe(400);
    expect(fake.tables.gitEvent).toHaveLength(0);
  });

  it('never stores or sends commit messages, author emails or file lists', async () => {
    const secret = 'SECRET-MESSAGE fix the thing';
    const email = 'dev@example.com';
    const p = fixture('push');
    const commit = {
      id: E,
      message: secret,
      author: { name: 'Dev', email, username: 'dev' },
      committer: { name: 'Dev', email },
      added: ['src/secret-file.ts'],
      removed: [],
      modified: ['README.md'],
    };
    p.commits = [commit];
    p.head_commit = commit;
    p.pusher = { name: 'dev', email };

    const r = await deliver('push', p);
    expect(r.status).toBe(200);

    const dump = JSON.stringify({ rows: fake.tables, events: h.send.mock.calls, res: r.body });
    for (const needle of [secret, email, 'secret-file', 'README.md']) {
      expect(dump).not.toContain(needle);
    }
    expect(Object.keys(fake.tables.gitEvent[0]!).sort()).toEqual(
      [
        'after',
        'before',
        'deliveryId',
        'id',
        'kind',
        'prNumber',
        'receivedAt',
        'ref',
        'repoId',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------- pull_request

describe('pull_request', () => {
  it('keeps the review behavior and also sends tree/refs-changed', async () => {
    const r = await deliver('pull_request', fixture('pull_request.opened'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, note: 'review queued', tree: 'pull_request' });

    expect(fake.tables.review).toHaveLength(1);
    expect(sent('review/requested')).toHaveLength(1);

    expect(fake.tables.gitEvent).toEqual([
      expect.objectContaining({
        kind: 'pull_request',
        ref: 'feat/rate-limit',
        after: 'a'.repeat(40),
        before: null,
        prNumber: 12,
      }),
    ]);
    const [evt] = sent('tree/refs-changed');
    expect(Object.keys(evt!.data).sort()).toEqual(['eventId', 'orgId', 'repoId']);
  });

  it('records closed (merged) PRs', async () => {
    await deliver('pull_request', fixture('pull_request.closed'));
    expect(fake.tables.gitEvent).toEqual([expect.objectContaining({ kind: 'pull_request' })]);
  });

  it('edited: only when the base changed', async () => {
    const title = fixture('pull_request.opened');
    title.action = 'edited';
    title.changes = { title: { from: 'old title' } };
    await deliver('pull_request', title);
    expect(fake.tables.gitEvent).toHaveLength(0);

    const base = fixture('pull_request.opened');
    base.action = 'edited';
    base.changes = { base: { ref: { from: 'develop' } } };
    await deliver('pull_request', base);
    expect(fake.tables.gitEvent).toHaveLength(1);
  });

  it('ignores actions that do not change the tree (labeled)', async () => {
    const labeled = fixture('pull_request.opened');
    labeled.action = 'labeled';
    await deliver('pull_request', labeled);
    expect(fake.tables.gitEvent).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a tree failure does not change the review response', async () => {
    h.send.mockImplementation(async (evt: any) => {
      if (evt.name === 'tree/refs-changed') throw new Error('inngest down');
      return { ids: ['evt'] };
    });
    const r = await deliver('pull_request', fixture('pull_request.opened'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, note: 'review queued' });
    expect(r.body.tree).toBeUndefined();
    expect(fake.tables.review).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- CI

describe('CI events', () => {
  beforeEach(() => {
    fake.tables.branch.push({
      id: 'b1',
      repoId: 'repo1',
      name: 'main',
      headSha: E,
      deletedAt: null,
    });
  });

  it('check_run failure on a branch head → CommitCi failure, ci event, send', async () => {
    const r = await deliver('check_run', fixture('check_run.completed'));
    expect(r.body).toMatchObject({ handled: true, note: 'ci' });
    expect(fake.tables.commitCi).toEqual([
      expect.objectContaining({
        repoId: 'repo1',
        sha: E,
        state: 'failure',
        counts: { success: 0, failure: 1, pending: 0, neutral: 0 },
      }),
    ]);
    expect(fake.tables.gitEvent).toEqual([
      expect.objectContaining({ kind: 'ci', ref: null, after: E }),
    ]);
    expect(sent('tree/refs-changed')).toHaveLength(1);
  });

  it('a success is provisional (pending) so the sync fetches the combined state', async () => {
    await deliver('check_suite', fixture('check_suite.completed'));
    expect(fake.tables.commitCi[0]).toMatchObject({ state: 'pending' });
  });

  it('a newer non-failure event moves a failed head back to pending', async () => {
    await deliver('check_run', fixture('check_run.completed'));
    const rerun = fixture('check_run.completed');
    rerun.action = 'created';
    rerun.check_run.status = 'queued';
    rerun.check_run.conclusion = null;
    await deliver('check_run', rerun);
    expect(fake.tables.commitCi).toHaveLength(1);
    expect(fake.tables.commitCi[0]).toMatchObject({ state: 'pending' });
  });

  it('status event (its commit object is not read)', async () => {
    const p = fixture('status');
    p.commit = {
      sha: E,
      commit: { message: 'SECRET-MESSAGE', author: { email: 'x@example.com' } },
    };
    p.state = 'error';
    await deliver('status', p);
    expect(fake.tables.commitCi[0]).toMatchObject({ state: 'failure' });
    const dump = JSON.stringify({ rows: fake.tables, events: h.send.mock.calls });
    expect(dump).not.toContain('SECRET-MESSAGE');
    expect(dump).not.toContain('x@example.com');
  });

  it('ignores CI for SHAs that are not a live branch head', async () => {
    fake.tables.branch[0]!.deletedAt = new Date();
    const r = await deliver('status', fixture('status'));
    expect(r.body).toMatchObject({ handled: false, note: 'not a branch head' });
    expect(fake.tables.commitCi).toHaveLength(0);
    expect(fake.tables.gitEvent).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});

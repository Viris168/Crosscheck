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
    send: vi.fn(async () => ({ ids: ['evt'] })),
    getInstallationOctokit: vi.fn(async () => ({})),
    fetchPullRequest: vi.fn(),
    syncUserMemberships: vi.fn(async () => ({ joined: [] as string[], left: [] as string[] })),
  };
});

vi.mock('@app/db', () => ({
  prisma: new Proxy(
    {},
    { get: (_t, k) => (h.state.fake!.db as Record<string, unknown>)[k as string] },
  ),
}));
vi.mock('@/server/jobs', () => ({ inngest: { send: h.send } }));
vi.mock('./membership', () => ({ syncUserMemberships: h.syncUserMemberships }));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    set: async (key: string, value: string, _ex: string, _ttl: number, nx: string) => {
      if (h.redisDown.value) throw new Error('ECONNREFUSED');
      expect(nx).toBe('NX');
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
vi.mock('@app/github', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInstallationOctokit: h.getInstallationOctokit,
  fetchPullRequest: h.fetchPullRequest,
}));

const SECRET = 'test-webhook-secret';
vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);

const { handleGithubWebhook, DELIVERY_TTL_SECONDS } = await import('./index');

// ---------------------------------------------------------------- helpers

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'));

let deliverySeq = 0;

function webhookRequest(
  event: string,
  payload: unknown,
  opts: { delivery?: string; signature?: string | null; raw?: string } = {},
): Request {
  const raw = opts.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': opts.delivery ?? `delivery-${++deliverySeq}`,
  };
  const sig = opts.signature === undefined ? signWebhookBody(raw, SECRET) : opts.signature;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return new Request('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers,
    body: raw,
  });
}

async function deliver(
  event: string,
  payload: unknown,
  opts?: Parameters<typeof webhookRequest>[2],
) {
  const res = await handleGithubWebhook(webhookRequest(event, payload, opts));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let fake: FakeDb;

/** Installs Acme with repos web + api via the real handler. */
async function install() {
  const r = await deliver('installation', fixture('installation.created'));
  expect(r.status).toBe(200);
}

function setRepo(fullName: string, patch: Record<string, unknown>) {
  const repo = fake.tables.repo.find((r) => r.fullName === fullName)!;
  Object.assign(repo, patch);
  return repo;
}

beforeEach(() => {
  fake = createFakeDb();
  h.state.fake = fake;
  h.redisStore.clear();
  h.redisDown.value = false;
  h.send.mockReset().mockResolvedValue({ ids: ['evt'] });
  h.getInstallationOctokit.mockClear();
  h.fetchPullRequest.mockReset();
  h.syncUserMemberships.mockClear();
  // alice has signed in with GitHub before installing the app.
  fake.tables.account.push({
    id: 'acc1',
    providerId: 'github',
    accountId: '7001',
    userId: 'user-alice',
  });
});

// ---------------------------------------------------------------- signature + transport

describe('POST /api/webhooks/github — transport', () => {
  it('rejects an invalid signature with 401 and does nothing', async () => {
    const r = await deliver('installation', fixture('installation.created'), {
      signature: 'sha256=' + '0'.repeat(64),
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
    expect(fake.tables.organization).toHaveLength(0);
    expect(h.redisStore.size).toBe(0);
  });

  it('rejects a missing signature header with 401', async () => {
    const r = await deliver('installation', fixture('installation.created'), { signature: null });
    expect(r.status).toBe(401);
  });

  it('verifies the signature over the raw bytes (whitespace matters)', async () => {
    const raw = JSON.stringify(fixture('pull_request.opened'), null, 2);
    const signedCompact = signWebhookBody(JSON.stringify(JSON.parse(raw)), SECRET);
    const r = await deliver('pull_request', null, { raw, signature: signedCompact });
    expect(r.status).toBe(401);
  });

  it('acknowledges events we do not handle', async () => {
    const r = await deliver('ping', { zen: 'hi' });
    expect(r).toEqual({ status: 200, body: { ok: true, ignored: 'ping' } });
  });

  it('400s on missing delivery id or a payload of the wrong shape', async () => {
    const req = webhookRequest('pull_request', {});
    req.headers.delete('x-github-delivery');
    expect((await handleGithubWebhook(req)).status).toBe(400);

    const r = await deliver('pull_request', { action: 'opened', pull_request: { nope: 1 } });
    expect(r.status).toBe(400);
  });

  it('dedupes repeated deliveries for 24h via Redis SET NX', async () => {
    await install();
    const payload = fixture('pull_request.opened');
    const first = await deliver('pull_request', payload, { delivery: 'same-id' });
    const second = await deliver('pull_request', payload, { delivery: 'same-id' });
    expect(first.body.reviewId).toBeDefined();
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(fake.tables.review).toHaveLength(1);
    expect(DELIVERY_TTL_SECONDS).toBe(86_400);
    expect(h.redisStore.has('gh:delivery:same-id')).toBe(true);
  });

  it('still processes when Redis is down', async () => {
    await install();
    h.redisDown.value = true;
    const r = await deliver('pull_request', fixture('pull_request.opened'));
    expect(r.status).toBe(200);
    expect(fake.tables.review).toHaveLength(1);
  });

  it('releases the delivery id when the handler fails so a redelivery can retry', async () => {
    await install();
    h.send.mockRejectedValueOnce(new Error('inngest down'));
    const payload = fixture('pull_request.opened');
    const failed = await deliver('pull_request', payload, { delivery: 'retry-me' });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('internal');
    // The queued review was rolled back.
    expect(fake.tables.review).toHaveLength(0);

    const retried = await deliver('pull_request', payload, { delivery: 'retry-me' });
    expect(retried.status).toBe(200);
    expect(fake.tables.review).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------- installation events

describe('installation events', () => {
  it('created: creates the org, installation, repos (platform + defaults) and owner', async () => {
    await install();
    const [org] = fake.tables.organization;
    expect(org).toMatchObject({ name: 'Acme', slug: 'acme', githubAccountLogin: 'Acme' });
    expect(fake.tables.installation).toEqual([
      expect.objectContaining({ githubInstallationId: 1001, orgId: org!.id }),
    ]);
    expect(fake.tables.repo.map((r) => [r.githubRepoId, r.fullName, r.provider, r.active])).toEqual(
      [
        [2001, 'Acme/web', 'platform', true],
        [2002, 'Acme/api', 'platform', true],
      ],
    );
    expect(fake.tables.repo[0]!.settings).toMatchObject({
      trigger: 'every_push',
      minSeverity: 'medium',
    });
    expect(fake.tables.member).toEqual([
      expect.objectContaining({ organizationId: org!.id, userId: 'user-alice', role: 'owner' }),
    ]);
    expect(org!.githubAccountType).toBe('Organization');
  });

  it('created: a personal account stores githubAccountType User', async () => {
    const p = fixture('installation.created');
    p.installation.account = { login: 'carol', id: 5002, type: 'User' };
    await deliver('installation', p);
    expect(fake.tables.organization[0]).toMatchObject({
      githubAccountLogin: 'carol',
      githubAccountType: 'User',
    });
  });

  it('new_permissions_accepted: sets githubAccountType on an old org and clears needsMemberPermission', async () => {
    await install();
    const org = fake.tables.organization[0]!;
    org.githubAccountType = null;
    fake.tables.installation[0]!.needsMemberPermission = true;

    const r = await deliver('installation', {
      ...fixture('installation.created'),
      action: 'new_permissions_accepted',
    });
    expect(r.status).toBe(200);
    expect(org.githubAccountType).toBe('Organization');
    expect(fake.tables.installation[0]!.needsMemberPermission).toBe(false);
  });

  it('created again (not new_permissions_accepted) leaves needsMemberPermission alone', async () => {
    await install();
    fake.tables.installation[0]!.needsMemberPermission = true;
    await deliver('installation', fixture('installation.created'));
    expect(fake.tables.installation[0]!.needsMemberPermission).toBe(true);
  });

  it('created: links to an existing org by githubAccountLogin (case-insensitive)', async () => {
    fake.tables.organization.push({
      id: 'org-existing',
      slug: 'acme-inc',
      githubAccountLogin: 'acme',
    });
    fake.tables.member.push({
      id: 'm0',
      organizationId: 'org-existing',
      userId: 'user-carol',
      role: 'owner',
    });
    await install();
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.installation[0]!.orgId).toBe('org-existing');
    // Existing members are left alone; alice is not auto-added to an org that already has owners.
    expect(fake.tables.member).toHaveLength(1);
  });

  it('created: picks a different slug if one is taken by an unrelated org', async () => {
    fake.tables.organization.push({ id: 'other', slug: 'acme', githubAccountLogin: null });
    await install();
    expect(fake.tables.organization[1]).toMatchObject({
      slug: 'acme-gh5001',
      githubAccountLogin: 'Acme',
    });
  });

  it('created: no member when the installer never signed in', async () => {
    fake.tables.account.length = 0;
    await install();
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.member).toHaveLength(0);
  });

  it('deleted: marks every repo of the installation inactive', async () => {
    await install();
    const r = await deliver('installation', fixture('installation.deleted'));
    expect(r.status).toBe(200);
    expect(fake.tables.repo.every((x) => x.active === false)).toBe(true);
  });

  it('installation_repositories added/removed', async () => {
    await install();
    setRepo('Acme/web', { provider: 'claude_action' });

    await deliver('installation_repositories', fixture('installation_repositories.added'));
    expect(fake.tables.repo.find((r) => r.githubRepoId === 2003)).toMatchObject({
      fullName: 'Acme/docs',
      provider: 'platform',
      active: true,
    });

    await deliver('installation_repositories', fixture('installation_repositories.removed'));
    expect(fake.tables.repo.find((r) => r.githubRepoId === 2002)!.active).toBe(false);
    expect(fake.tables.repo.find((r) => r.githubRepoId === 2001)!.active).toBe(true);

    // Re-adding keeps the user's provider choice and reactivates.
    const readd = fixture('installation_repositories.added');
    readd.repositories_added = [{ id: 2001, full_name: 'Acme/web' }];
    await deliver('installation_repositories', readd);
    expect(fake.tables.repo.find((r) => r.githubRepoId === 2001)).toMatchObject({
      provider: 'claude_action',
      active: true,
    });
  });
});

// ---------------------------------------------------------------- pull_request events

describe('pull_request events', () => {
  beforeEach(install);

  it('opened on a runsInWorker provider → PR upserted, review queued, exactly one review/requested', async () => {
    const r = await deliver('pull_request', fixture('pull_request.opened'));
    expect(r.status).toBe(200);

    expect(fake.tables.pullRequest).toEqual([
      expect.objectContaining({
        number: 12,
        title: 'Add login rate limiting',
        author: 'bob',
        state: 'open',
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        headRef: 'feat/rate-limit',
        additions: 120,
        changedFiles: 4,
      }),
    ]);
    const [review] = fake.tables.review;
    expect(review).toMatchObject({
      provider: 'platform',
      status: 'queued',
      headSha: 'a'.repeat(40),
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith({
      name: 'review/requested',
      data: { reviewId: review!.id, orgId: fake.tables.organization[0]!.id },
    });
  });

  it('event payload carries ids only', async () => {
    await deliver('pull_request', fixture('pull_request.opened'));
    const [[evt]] = h.send.mock.calls as unknown as [[{ data: object }]];
    expect(Object.keys(evt.data).sort()).toEqual(['orgId', 'reviewId']);
  });

  it('codex_chatgpt also runs in the worker', async () => {
    setRepo('Acme/web', { provider: 'codex_chatgpt' });
    await deliver('pull_request', fixture('pull_request.opened'));
    expect(fake.tables.review[0]).toMatchObject({ provider: 'codex_chatgpt', status: 'queued' });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each(['claude_action', 'codex_action'])(
    '%s → waiting_action and no event',
    async (provider) => {
      setRepo('Acme/web', { provider });
      await deliver('pull_request', fixture('pull_request.opened'));
      expect(fake.tables.review[0]).toMatchObject({ provider, status: 'waiting_action' });
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it('skips drafts (PR still upserted), then reviews on ready_for_review', async () => {
    const draft = fixture('pull_request.opened');
    draft.pull_request.draft = true;
    const r = await deliver('pull_request', draft);
    expect(r.body.note).toBe('draft skipped');
    expect(fake.tables.pullRequest).toHaveLength(1);
    expect(fake.tables.review).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();

    const ready = fixture('pull_request.opened');
    ready.action = 'ready_for_review';
    await deliver('pull_request', ready);
    expect(fake.tables.review).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('on_command trigger: upserts the PR but creates no review', async () => {
    setRepo('Acme/web', { settings: { trigger: 'on_command' } });
    await deliver('pull_request', fixture('pull_request.opened'));
    expect(fake.tables.pullRequest).toHaveLength(1);
    expect(fake.tables.review).toHaveLength(0);
  });

  it('never creates two reviews for the same [pr, headSha, provider]', async () => {
    await deliver('pull_request', fixture('pull_request.opened'));
    const reopened = fixture('pull_request.opened');
    reopened.action = 'reopened';
    const r = await deliver('pull_request', reopened);
    expect(r.body.note).toBe('review already exists');
    expect(fake.tables.review).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('synchronize: new headSha → new review, PR head updated', async () => {
    await deliver('pull_request', fixture('pull_request.opened'));
    await deliver('pull_request', fixture('pull_request.synchronize'));
    expect(fake.tables.pullRequest).toHaveLength(1);
    expect(fake.tables.pullRequest[0]!.headSha).toBe('c'.repeat(40));
    expect(fake.tables.review.map((r) => r.headSha)).toEqual(['a'.repeat(40), 'c'.repeat(40)]);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('closed: merged → state merged; not merged → closed; no review', async () => {
    await deliver('pull_request', fixture('pull_request.opened'));
    await deliver('pull_request', fixture('pull_request.closed'));
    expect(fake.tables.pullRequest[0]!.state).toBe('merged');

    const closed = fixture('pull_request.closed');
    closed.pull_request.merged = false;
    await deliver('pull_request', closed);
    expect(fake.tables.pullRequest[0]!.state).toBe('closed');
    expect(fake.tables.review).toHaveLength(1); // only the one from "opened"
  });

  it('ignores PRs on unknown or inactive repos and other actions', async () => {
    const other = fixture('pull_request.opened');
    other.repository.id = 9999;
    expect((await deliver('pull_request', other)).body.handled).toBe(false);

    setRepo('Acme/web', { active: false });
    expect((await deliver('pull_request', fixture('pull_request.opened'))).body.handled).toBe(
      false,
    );

    const labeled = fixture('pull_request.opened');
    labeled.action = 'labeled';
    expect((await deliver('pull_request', labeled)).body.handled).toBe(false);

    expect(fake.tables.pullRequest).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- /review command

describe('issue_comment /review', () => {
  beforeEach(async () => {
    await install();
    setRepo('Acme/web', { settings: { trigger: 'on_command' } });
    await deliver('pull_request', fixture('pull_request.opened'));
  });

  it('creates a queued review + one event for the PR head', async () => {
    const r = await deliver('issue_comment', fixture('issue_comment.created'));
    expect(r.body.reviewId).toBeDefined();
    expect(fake.tables.review).toEqual([
      expect.objectContaining({ status: 'queued', headSha: 'a'.repeat(40), provider: 'platform' }),
    ]);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('action provider → waiting_action, no event', async () => {
    setRepo('Acme/web', { provider: 'codex_action' });
    await deliver('issue_comment', fixture('issue_comment.created'));
    expect(fake.tables.review[0]).toMatchObject({ status: 'waiting_action' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a second /review on the same head does not duplicate', async () => {
    await deliver('issue_comment', fixture('issue_comment.created'));
    await deliver('issue_comment', fixture('issue_comment.created'));
    expect(fake.tables.review).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not a command', (p: any) => (p.comment.body = 'LGTM, will /review later')],
    ['/reviewer is not /review', (p: any) => (p.comment.body = '/reviewer')],
    ['plain issue', (p: any) => (p.issue.pull_request = undefined)],
    ['edited comment', (p: any) => (p.action = 'edited')],
    ['untrusted commenter', (p: any) => (p.comment.author_association = 'NONE')],
    ['bot', (p: any) => (p.comment.user.type = 'Bot')],
  ])('ignores: %s', async (_name, mutate) => {
    const p = fixture('issue_comment.created');
    mutate(p);
    const r = await deliver('issue_comment', p);
    expect(r.body.handled).toBe(false);
    expect(fake.tables.review).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('accepts a bare "/review"', async () => {
    const p = fixture('issue_comment.created');
    p.comment.body = '  /review\n';
    await deliver('issue_comment', p);
    expect(fake.tables.review).toHaveLength(1);
  });

  it('ignores closed PRs', async () => {
    await deliver('pull_request', fixture('pull_request.closed'));
    const r = await deliver('issue_comment', fixture('issue_comment.created'));
    expect(r.body.handled).toBe(false);
    expect(fake.tables.review).toHaveLength(0);
  });

  it('fetches the PR from GitHub when we have no row for it', async () => {
    fake.tables.pullRequest.length = 0;
    h.fetchPullRequest.mockResolvedValue({
      number: 12,
      title: 'From API',
      body: '',
      author: 'bob',
      state: 'open',
      merged: false,
      draft: false,
      headSha: 'd'.repeat(40),
      headRef: 'x',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
    await deliver('issue_comment', fixture('issue_comment.created'));
    expect(h.getInstallationOctokit).toHaveBeenCalledWith(1001);
    expect(h.fetchPullRequest).toHaveBeenCalledWith(expect.anything(), 'Acme', 'web', 12);
    expect(fake.tables.pullRequest[0]).toMatchObject({
      title: 'From API',
      headSha: 'd'.repeat(40),
    });
    expect(fake.tables.review[0]).toMatchObject({ headSha: 'd'.repeat(40) });
  });
});

// ---------------------------------------------------------------- organization + member events

describe('organization events', () => {
  beforeEach(async () => {
    await install(); // alice is owner of Acme
    fake.tables.account.push({
      id: 'acc2',
      providerId: 'github',
      accountId: '7002',
      userId: 'u-bob',
    });
    const orgId = fake.tables.organization[0]!.id;
    fake.tables.member.push({ id: 'm-bob', organizationId: orgId, userId: 'u-bob', role: 'admin' });
  });

  it("member_removed deletes that user's Member row (matched by GitHub id)", async () => {
    const r = await deliver('organization', fixture('organization.member_removed'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, note: 'member removed' });
    expect(fake.tables.member.map((m) => m.userId)).toEqual(['user-alice']);
  });

  it('matches the org login case-insensitively', async () => {
    const p = fixture('organization.member_removed');
    p.organization.login = 'ACME';
    await deliver('organization', p);
    expect(fake.tables.member.map((m) => m.userId)).toEqual(['user-alice']);
  });

  it('matches the user by GitHub id, never by login', async () => {
    const p = fixture('organization.member_removed');
    p.membership.user = { login: 'bob', id: 9999 };
    const r = await deliver('organization', p);
    expect(r.body).toMatchObject({ handled: false, note: 'unknown user' });
    expect(fake.tables.member).toHaveLength(2);
  });

  it('an unknown organization is a no-op', async () => {
    const p = fixture('organization.member_removed');
    p.organization.login = 'Elsewhere';
    const r = await deliver('organization', p);
    expect(r.body).toMatchObject({ handled: false });
    expect(fake.tables.member).toHaveLength(2);
  });

  it('member_added does nothing (they join at next sign-in)', async () => {
    const r = await deliver('organization', {
      ...fixture('organization.member_removed'),
      action: 'member_added',
    });
    expect(r.body).toMatchObject({ handled: false });
    expect(fake.tables.member).toHaveLength(2);
    expect(h.syncUserMemberships).not.toHaveBeenCalled();
  });

  it('rejects a payload without an organization (400)', async () => {
    const r = await deliver('organization', { action: 'member_removed' });
    expect(r.status).toBe(400);
  });
});

describe('member events (repo collaborators)', () => {
  beforeEach(async () => {
    await install();
    fake.tables.account.push({
      id: 'acc2',
      providerId: 'github',
      accountId: '7002',
      userId: 'u-bob',
    });
    h.redisStore.set('gh:perm:2001:bob', 'write');
    h.redisStore.set('gh:perm:2002:bob', 'write');
  });

  it.each(['removed', 'edited'])('%s invalidates the cached repo permission', async (action) => {
    const r = await deliver('member', { ...fixture('member.removed'), action });
    expect(r.status).toBe(200);
    expect(h.redisStore.has('gh:perm:2001:bob')).toBe(false);
    expect(h.redisStore.has('gh:perm:2002:bob')).toBe(true);
  });

  it('invalidates using a lower-cased login', async () => {
    const p = fixture('member.removed');
    p.member.login = 'Bob';
    await deliver('member', p);
    expect(h.redisStore.has('gh:perm:2001:bob')).toBe(false);
  });

  it('on an org install it does not run the membership sync', async () => {
    await deliver('member', fixture('member.removed'));
    expect(h.syncUserMemberships).not.toHaveBeenCalled();
  });

  it("on a personal install it also syncs that user's memberships", async () => {
    fake.tables.organization[0]!.githubAccountType = 'User';
    const r = await deliver('member', fixture('member.removed'));
    expect(r.status).toBe(200);
    expect(h.syncUserMemberships).toHaveBeenCalledWith('u-bob');
  });

  it('an unknown user is a no-op', async () => {
    fake.tables.organization[0]!.githubAccountType = 'User';
    const p = fixture('member.removed');
    p.member.id = 9999;
    const r = await deliver('member', p);
    expect(r.body).toMatchObject({ handled: false, note: 'unknown user' });
    expect(h.redisStore.has('gh:perm:2001:bob')).toBe(true);
    expect(h.syncUserMemberships).not.toHaveBeenCalled();
  });

  it('ignores member.added', async () => {
    const r = await deliver('member', { ...fixture('member.removed'), action: 'added' });
    expect(r.body).toMatchObject({ handled: false });
    expect(h.redisStore.has('gh:perm:2001:bob')).toBe(true);
  });
});

// ---------------------------------------------------------------- route

describe('route file', () => {
  it('is a thin nodejs POST handler', async () => {
    const route = await import('@/app/api/webhooks/github/route');
    expect(route.runtime).toBe('nodejs');
    const res = await route.POST(webhookRequest('ping', { zen: 'hi' }));
    expect(res.status).toBe(200);
  });
});

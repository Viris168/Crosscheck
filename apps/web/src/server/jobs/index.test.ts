import { describe, expect, it, vi } from 'vitest';
import { functions, inngest, requestTreeSync } from './index';

describe('@/server/jobs', () => {
  it('exports the Inngest client with the app id', () => {
    expect(inngest.id).toBe('ai-review');
  });

  it('registers the review, member and branch-tree functions', () => {
    const ids = functions.map((f) => f.id());
    expect(ids).toEqual([
      'review-start',
      'review-finalize',
      'review-sweep',
      'member-sync',
      'member-prune',
      'tree-sync',
      'tree-refresh',
      'tree-cron',
    ]);
  });

  it('configures triggers, per-org concurrency and retries', () => {
    const configs = functions.map(
      (f) =>
        f['getConfig']({
          baseUrl: new URL('http://localhost/api/inngest'),
          appPrefix: 'ai-review',
        })[0],
    );
    const [start, finalize, sweep, memberSync, memberPrune, treeSync, treeRefresh, treeCron] =
      configs;
    expect(start?.triggers).toEqual([{ event: 'review/requested' }]);
    expect(start?.concurrency).toEqual({ key: 'event.data.orgId', limit: 3 });
    expect(finalize?.triggers).toEqual([{ event: 'review/finalize' }]);
    expect(sweep?.triggers).toEqual([{ cron: '*/5 * * * *' }]);
    expect(memberSync?.triggers).toEqual([{ event: 'user/signed-in' }]);
    expect(memberSync?.concurrency).toEqual({ key: 'event.data.userId', limit: 1 });
    expect(memberPrune?.triggers).toEqual([{ cron: '*/30 * * * *' }]);
    expect(treeSync?.triggers).toEqual([{ event: 'tree/sync-requested' }]);
    expect(treeSync?.concurrency).toEqual([
      { key: 'event.data.repoId', limit: 1 },
      { key: 'event.data.orgId', limit: 2 },
    ]);
    // 10 events in 1 s → one run: debounced per repo, then one run per repo at a time.
    expect(treeRefresh?.triggers).toEqual([{ event: 'tree/refs-changed' }]);
    expect(treeRefresh?.debounce).toEqual({
      key: 'event.data.repoId',
      period: '2s',
      timeout: '10s',
    });
    expect(treeRefresh?.concurrency).toEqual({ key: 'event.data.repoId', limit: 1 });
    expect(treeCron?.triggers).toEqual([{ cron: '*/15 * * * *' }]);
    expect(start?.steps?.step?.retries).toEqual({ attempts: 2 }); // = retries (2 retries after the first try);
  });
});

describe('requestTreeSync', () => {
  it('sends tree/sync-requested with ids and the reason only', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: ['e1'] });
    await requestTreeSync('repo_1', 'org_1', 'first_view');
    expect(send).toHaveBeenCalledWith({
      name: 'tree/sync-requested',
      data: { repoId: 'repo_1', orgId: 'org_1', reason: 'first_view' },
    });
    send.mockRestore();
  });
});

describe('event typing', () => {
  it('only accepts known events with typed payloads', () => {
    // Compile-time check: these lines fail typecheck if the schemas are not wired.
    type Send = Parameters<typeof inngest.send>[0];
    const ok: Send = { name: 'review/requested', data: { reviewId: 'r', orgId: 'o' } };
    // @ts-expect-error missing orgId
    const bad: Send = { name: 'review/requested', data: { reviewId: 'r' } };
    // @ts-expect-error unknown event name
    const unknown: Send = { name: 'review/unknown', data: {} };
    const signedIn: Send = { name: 'user/signed-in', data: { userId: 'u' } };
    expect([ok, bad, unknown, signedIn]).toHaveLength(4);
  });
});

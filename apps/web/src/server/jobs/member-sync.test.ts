import { describe, expect, it, vi } from 'vitest';
import { createFakeRunner } from './__fixtures__/fake-step';
import { memberSyncHandler, type MemberSyncDeps } from './member-sync';

function makeDeps(sync: MemberSyncDeps['sync']) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { deps: { sync: vi.fn(sync), log }, log };
}

describe('member-sync', () => {
  it("calls the sync with the event's userId inside a step and logs counts only", async () => {
    const { deps, log } = makeDeps(async () => ({ joined: ['org-1', 'org-2'], left: ['org-3'] }));
    const runner = createFakeRunner();

    const out = await memberSyncHandler(
      { event: { data: { userId: 'user-1' } }, step: runner.step },
      deps,
    );

    expect(out).toEqual({ joined: 2, left: 1 });
    expect(deps.sync).toHaveBeenCalledOnce();
    expect(deps.sync).toHaveBeenCalledWith('user-1');
    expect([...runner.calls.keys()]).toEqual(['sync-memberships']);
    expect(log.info).toHaveBeenCalledWith(
      { userId: 'user-1', joined: 2, left: 1 },
      'member-sync done',
    );
  });

  it('retries the step when the sync throws', async () => {
    let n = 0;
    const { deps } = makeDeps(async () => {
      if (++n < 3) throw new Error('GitHub API error (502)');
      return { joined: ['org-1'], left: [] };
    });
    const runner = createFakeRunner({ retries: 3 });

    const out = await memberSyncHandler(
      { event: { data: { userId: 'user-1' } }, step: runner.step },
      deps,
    );

    expect(out).toEqual({ joined: 1, left: 0 });
    expect(runner.calls.get('sync-memberships')).toBe(3);
  });

  it('fails the run once retries are exhausted, without logging a result', async () => {
    const { deps, log } = makeDeps(async () => {
      throw new Error('boom');
    });
    const runner = createFakeRunner({ retries: 2 });

    await expect(
      memberSyncHandler({ event: { data: { userId: 'user-1' } }, step: runner.step }, deps),
    ).rejects.toThrow('boom');
    expect(runner.calls.get('sync-memberships')).toBe(3);
    expect(log.info).not.toHaveBeenCalled();
  });
});

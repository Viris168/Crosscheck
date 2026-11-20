import { describe, expect, it, vi } from 'vitest';
import { createFakeRunner } from './__fixtures__/fake-step';
import { memberPruneHandler, MEMBER_PRUNE_CRON, type MemberPruneDeps } from './member-prune';

function makeDeps(prune: MemberPruneDeps['prune']) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { deps: { prune: vi.fn(prune), log }, log };
}

describe('member-prune', () => {
  it('runs the prune inside a step and logs counts only', async () => {
    const { deps, log } = makeDeps(async () => ({ users: 4, left: 1 }));
    const runner = createFakeRunner();

    expect(await memberPruneHandler({ step: runner.step }, deps)).toEqual({ users: 4, left: 1 });
    expect(deps.prune).toHaveBeenCalledOnce();
    expect([...runner.calls.keys()]).toEqual(['prune-members']);
    expect(log.info).toHaveBeenCalledWith({ users: 4, left: 1 }, 'member-prune done');
  });

  it('retries the step when the prune throws', async () => {
    let n = 0;
    const { deps } = makeDeps(async () => {
      if (++n < 2) throw new Error('db down');
      return { users: 1, left: 0 };
    });
    const runner = createFakeRunner({ retries: 2 });

    expect(await memberPruneHandler({ step: runner.step }, deps)).toEqual({ users: 1, left: 0 });
    expect(runner.calls.get('prune-members')).toBe(2);
  });

  it('runs every 30 minutes', () => {
    expect(MEMBER_PRUNE_CRON).toBe('*/30 * * * *');
  });
});

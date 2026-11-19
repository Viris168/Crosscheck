import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMany = vi.fn();
vi.mock('@app/db', () => ({ prisma: { review: { updateMany } }, Prisma: { DbNull: null } }));

const { prismaJobsStore } = await import('./store');
const { reviewSweepHandler } = await import('./review-sweep');
const { makeDeps } = await import('./__fixtures__/deps');
const { createFakeRunner } = await import('./__fixtures__/fake-step');

describe('review-sweep', () => {
  beforeEach(() => {
    updateMany.mockReset();
    updateMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
  });

  it('fails waiting_action > 30 min as action_missing and running > 20 min as timeout', async () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const deps = { ...makeDeps({ store: prismaJobsStore, files: [] }), now: () => now };
    const runner = createFakeRunner();
    expect(await reviewSweepHandler({ step: runner.step }, deps)).toEqual({
      actionMissing: 2,
      timedOut: 1,
    });
    expect([...runner.calls.keys()]).toEqual(['sweep']);

    const [action, running] = updateMany.mock.calls.map((c) => c[0]);
    expect(action.where).toEqual({
      status: 'waiting_action',
      updatedAt: { lt: new Date('2026-11-19T11:30:00Z') },
    });
    expect(action.data).toMatchObject({
      status: 'failed',
      errorCode: 'action_missing',
      finishedAt: now,
    });
    const cutoff = new Date('2026-11-19T11:40:00Z');
    expect(running.where).toEqual({
      status: 'running',
      OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, updatedAt: { lt: cutoff } }],
    });
    expect(running.data).toMatchObject({ status: 'failed', errorCode: 'timeout', finishedAt: now });
  });
});

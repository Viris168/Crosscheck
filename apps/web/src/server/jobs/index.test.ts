import { describe, expect, it } from 'vitest';
import { functions, inngest } from './index';

describe('@/server/jobs', () => {
  it('exports the Inngest client with the app id', () => {
    expect(inngest.id).toBe('ai-review');
  });

  it('has no functions yet', () => {
    expect(functions).toEqual([]);
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
    expect([ok, bad, unknown]).toHaveLength(3);
  });
});

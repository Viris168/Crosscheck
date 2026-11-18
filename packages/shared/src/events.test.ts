import { describe, expect, it } from 'vitest';
import { events, eventSchemas, ReviewFinalizeEvent, ReviewRequestedEvent } from './events';

describe('events', () => {
  it('defines exactly the two review events', () => {
    expect(Object.keys(events).sort()).toEqual(['review/finalize', 'review/requested']);
  });

  it('review/requested needs reviewId + orgId', () => {
    expect(ReviewRequestedEvent.parse({ reviewId: 'r1', orgId: 'o1' })).toEqual({
      reviewId: 'r1',
      orgId: 'o1',
    });
    expect(ReviewRequestedEvent.safeParse({ reviewId: 'r1' }).success).toBe(false);
  });

  it('review/finalize needs reviewId and carries ids only', () => {
    expect(ReviewFinalizeEvent.parse({ reviewId: 'r1', patch: 'diff --git' })).toEqual({
      reviewId: 'r1',
    });
    expect(ReviewFinalizeEvent.safeParse({}).success).toBe(false);
  });
});

describe('eventSchemas', () => {
  it('maps the same event names to the same data schemas', () => {
    expect(Object.keys(eventSchemas).sort()).toEqual(Object.keys(events).sort());
    expect(eventSchemas['review/requested']).toBe(events['review/requested'].data);
    expect(eventSchemas['review/finalize']).toBe(events['review/finalize'].data);
  });
});

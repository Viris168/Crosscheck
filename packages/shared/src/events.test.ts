import { describe, expect, it } from 'vitest';
import {
  events,
  eventSchemas,
  ReviewFinalizeEvent,
  ReviewRequestedEvent,
  UserSignedInEvent,
} from './events';

describe('events', () => {
  it('defines exactly the review and sign-in events', () => {
    expect(Object.keys(events).sort()).toEqual([
      'review/finalize',
      'review/requested',
      'user/signed-in',
    ]);
  });

  it('user/signed-in needs a userId and carries ids only', () => {
    expect(UserSignedInEvent.parse({ userId: 'u1', token: 'gho_x' })).toEqual({ userId: 'u1' });
    expect(UserSignedInEvent.safeParse({}).success).toBe(false);
    expect(UserSignedInEvent.safeParse({ userId: '' }).success).toBe(false);
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
    expect(eventSchemas['user/signed-in']).toBe(events['user/signed-in'].data);
  });
});

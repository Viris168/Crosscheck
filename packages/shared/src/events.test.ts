import { describe, expect, it } from 'vitest';
import {
  events,
  eventSchemas,
  ReviewFinalizeEvent,
  ReviewRequestedEvent,
  TreeRefsChangedEvent,
  TreeSyncRequestedEvent,
  UserSignedInEvent,
} from './events';

describe('events', () => {
  it('defines exactly the review, sign-in and branch tree events', () => {
    expect(Object.keys(events).sort()).toEqual([
      'review/finalize',
      'review/requested',
      'tree/refs-changed',
      'tree/sync-requested',
      'user/signed-in',
    ]);
  });

  it('tree/sync-requested needs repoId, orgId and a known reason; carries ids only', () => {
    for (const reason of ['manual', 'first_view', 'webhook', 'cron']) {
      expect(TreeSyncRequestedEvent.parse({ repoId: 'r1', orgId: 'o1', reason })).toEqual({
        repoId: 'r1',
        orgId: 'o1',
        reason,
      });
    }
    expect(
      TreeSyncRequestedEvent.parse({ repoId: 'r1', orgId: 'o1', reason: 'cron', token: 'ghs_x' }),
    ).toEqual({ repoId: 'r1', orgId: 'o1', reason: 'cron' });
    expect(TreeSyncRequestedEvent.safeParse({ repoId: 'r1', orgId: 'o1' }).success).toBe(false);
    expect(
      TreeSyncRequestedEvent.safeParse({ repoId: 'r1', orgId: 'o1', reason: 'push' }).success,
    ).toBe(false);
    expect(TreeSyncRequestedEvent.safeParse({ orgId: 'o1', reason: 'manual' }).success).toBe(false);
  });

  it('tree/refs-changed needs repoId, orgId, eventId; carries ids only', () => {
    expect(
      TreeRefsChangedEvent.parse({ repoId: 'r1', orgId: 'o1', eventId: 'e1', commits: ['abc'] }),
    ).toEqual({ repoId: 'r1', orgId: 'o1', eventId: 'e1' });
    expect(TreeRefsChangedEvent.safeParse({ repoId: 'r1', orgId: 'o1' }).success).toBe(false);
    expect(TreeRefsChangedEvent.safeParse({ repoId: 'r1', orgId: 'o1', eventId: '' }).success).toBe(
      false,
    );
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
    expect(eventSchemas['tree/sync-requested']).toBe(events['tree/sync-requested'].data);
    expect(eventSchemas['tree/refs-changed']).toBe(events['tree/refs-changed'].data);
  });
});

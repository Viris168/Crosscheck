import type { ReviewStatus } from '@app/shared/client';

/** Statuses that change on their own; the UI polls them every 3s. */
export const ACTIVE_STATUSES: readonly ReviewStatus[] = ['queued', 'running', 'waiting_action'];
export const POLL_MS = 3000;

export const isActiveStatus = (s: ReviewStatus | undefined | null): boolean =>
  s != null && ACTIVE_STATUSES.includes(s);

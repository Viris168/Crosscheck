import { z } from 'zod';

// Inngest event names + payload schemas. Payloads carry ids only — never code, patches or tokens.

/** orgId is the Inngest concurrency key (3 reviews per org). */
export const ReviewRequestedEvent = z.object({ reviewId: z.string(), orgId: z.string() });
export const ReviewFinalizeEvent = z.object({ reviewId: z.string() });
/** Sent on every new Better Auth session; the job syncs the user's org memberships from GitHub. */
export const UserSignedInEvent = z.object({ userId: z.string().min(1) });

export const events = {
  'review/requested': { data: ReviewRequestedEvent },
  'review/finalize': { data: ReviewFinalizeEvent },
  'user/signed-in': { data: UserSignedInEvent },
} as const;

/** Event name → data schema (Standard Schema). For Inngest's `new EventSchemas().fromSchema(eventSchemas)`. */
export const eventSchemas = {
  'review/requested': ReviewRequestedEvent,
  'review/finalize': ReviewFinalizeEvent,
  'user/signed-in': UserSignedInEvent,
} as const;

export type EventName = keyof typeof events;
export type EventData<N extends EventName> = z.infer<(typeof events)[N]['data']>;

/** review-sweep is a cron function, no event. */
export const REVIEW_SWEEP_CRON = '*/5 * * * *';

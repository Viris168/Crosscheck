import { z } from 'zod';

// Inngest event names + payload schemas. Payloads carry ids only — never code, patches or tokens.

/** orgId is the Inngest concurrency key (3 reviews per org). */
export const ReviewRequestedEvent = z.object({ reviewId: z.string(), orgId: z.string() });
export const ReviewFinalizeEvent = z.object({ reviewId: z.string() });

export const events = {
  'review/requested': { data: ReviewRequestedEvent },
  'review/finalize': { data: ReviewFinalizeEvent },
} as const;

/** Event name → data schema (Standard Schema). For Inngest's `new EventSchemas().fromSchema(eventSchemas)`. */
export const eventSchemas = {
  'review/requested': ReviewRequestedEvent,
  'review/finalize': ReviewFinalizeEvent,
} as const;

export type EventName = keyof typeof events;
export type EventData<N extends EventName> = z.infer<(typeof events)[N]['data']>;

/** review-sweep is a cron function, no event. */
export const REVIEW_SWEEP_CRON = '*/5 * * * *';

// Public entry for lane B (Jobs). Other lanes import `inngest` from '@/server/jobs' to send events.
import type { InngestFunction } from 'inngest';
import { inngest } from './client';

export { inngest };

/** Registered Inngest functions (review-start, review-finalize, review-sweep — lane B). */
export const functions: InngestFunction.Any[] = [];

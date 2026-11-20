// Public entry for lane B (Jobs). Other lanes import `inngest` from '@/server/jobs' to send events.
import type { InngestFunction } from 'inngest';
import { inngest } from './client';
import { memberPrune, memberSync, reviewFinalize, reviewStart, reviewSweep } from './functions';

export { inngest };

/** Registered Inngest functions, served by `/api/inngest`. */
export const functions: InngestFunction.Any[] = [
  reviewStart,
  reviewFinalize,
  reviewSweep,
  memberSync,
  memberPrune,
];

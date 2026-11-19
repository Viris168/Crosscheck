// review-sweep (cron): stuck reviews → failed. waiting_action > 30 min → action_missing;
// running > 20 min → timeout (limits from LIMITS in @app/shared).
import type { JobDeps, StepTools } from './deps';

export async function reviewSweepHandler(
  ctx: { step: StepTools },
  deps: JobDeps,
): Promise<{ actionMissing: number; timedOut: number }> {
  const result = await ctx.step.run('sweep', () => deps.store.sweep(deps.now()));
  if (result.actionMissing > 0 || result.timedOut > 0) {
    deps.log.warn(result, 'review-sweep failed stuck reviews');
  }
  return result;
}

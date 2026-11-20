// member-prune (cron): drop memberships GitHub no longer backs, for removals no webhook reported.
// Personal-account installs get no `member` webhooks, and org webhooks can be missed while the app
// is down. The prune itself (lane A, `pruneRemovedMembers`) is removals-only and safe to repeat.
import type { JobLogger } from './deps';

/** Every 30 minutes: a removed collaborator keeps an (empty) membership for at most this long. */
export const MEMBER_PRUNE_CRON = '*/30 * * * *';

export interface MemberPruneDeps {
  prune(): Promise<{ users: number; left: number }>;
  log: JobLogger;
}

/** The subset of Inngest's `step` this handler uses. */
export interface MemberPruneStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function memberPruneHandler(
  ctx: { step: MemberPruneStep },
  deps: MemberPruneDeps,
): Promise<{ users: number; left: number }> {
  const result = await ctx.step.run('prune-members', () => deps.prune());
  // Counts only: never user ids, logins or org names.
  deps.log.info(result, 'member-prune done');
  return result;
}

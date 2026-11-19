// member-sync (`user/signed-in`): match the user's org memberships to GitHub.
// The sync itself (lane A, `syncUserMemberships`) is safe to repeat, so default retries apply.
import type { JobLogger } from './deps';

export interface MemberSyncResult {
  joined: string[];
  left: string[];
}

export interface MemberSyncDeps {
  sync(userId: string): Promise<MemberSyncResult>;
  log: JobLogger;
}

/** The subset of Inngest's `step` this handler uses. */
export interface MemberSyncStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function memberSyncHandler(
  ctx: { event: { data: { userId: string } }; step: MemberSyncStep },
  deps: MemberSyncDeps,
): Promise<{ joined: number; left: number }> {
  const { userId } = ctx.event.data;
  const result = await ctx.step.run('sync-memberships', () => deps.sync(userId));
  const counts = { joined: result.joined.length, left: result.left.length };
  // Counts only: never logins, org names or tokens.
  deps.log.info({ userId, ...counts }, 'member-sync done');
  return counts;
}

# T8a — Snapshots from recorded events (Lane B, milestone 8, optional)

**Wave 7** · **Branch:** `feat/t8a-snapshots` · **Lane:** B · **Needs merged:** T7
**Spec:** `tasks/T-branch-tree.md` → "Contracts" (`GitEvent`), "Milestones" row 8.

## You own (edit only these)
- `apps/web/src/server/jobs/tree-history.ts` (new) + test, `jobs/index.ts`

## Do
1. `refsAt(repoId, at: Date)` → `{ branches: { name, headSha }[] }` by replaying `GitEvent`s backwards from
   the current `Branch` rows (each event has `before`/`after`). Before the first recorded event the answer is
   "unknown" (return `null`; the UI shows the earliest available moment).
2. `snapshotAt(repoId, at)` → `TreeSnapshot` built with `@app/git-graph` on the cached graph, using the refs at
   that moment, PR states as of `at` (`PullRequest.mergedAt`, events of kind `pull_request`) and the overrides
   that exist now (say so in the UI).
3. Commits that are no longer reachable (force-pushed away) are not in the commits-only clone: fetch them by SHA
   into the cache (`git fetch origin <sha>` with `--filter=tree:0`) when GitHub still has them; otherwise mark
   the branch `unavailable` in that snapshot.
4. Retention: keep `GitEvent`s 90 days (daily cron deletes older ones). Write the number in the T-spec.
5. Export `snapshotAt` from `@/server/jobs`; it runs inside the API request (no Inngest), with a 2 s budget and a
   Redis cache keyed by `repoId@minute`.

## Tests
Replay over create / push / force-push / delete; before first event → null; unreachable commit fallback.

## Not yours
The `?at=` route and the slider (T8b). (Contract: `GetTreeQuery.at` already exists from T0.)

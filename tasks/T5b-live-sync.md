# T5b — Incremental sync + recorded parent (Lane B, milestone 5)

**Wave 4** · **Branch:** `feat/t5b-live-sync` · **Lane:** B · **Needs merged:** T2c, T3b
**Spec:** `tasks/T-branch-tree.md` → "Compare-with rules" (rule 4 `recorded`), "Contracts".
**Mocks until merged:** `GitEvent` rows written by T5a (insert them in tests).

## You own (edit only these)
- `apps/web/src/server/jobs/tree-refresh.ts` (new) + test, `jobs/tree-sync.ts`, `jobs/functions.ts`,
  `jobs/index.ts`

## Do
1. **`tree-refresh`** on `tree/refs-changed`, debounced per repo (`debounce: { key: repoId, period: '2s' }`,
   VERIFY Inngest v3 option) and concurrency 1 per repo:
   - Read the `GitEvent`s since the last refresh. Update only touched `Branch` rows.
   - `git fetch` only the touched refs (`git fetch origin <ref>:<ref>` with `--filter=tree:0`); deleted
     branches → `git update-ref -d`.
   - CI-only events skip the fetch.
   - Rebuild the snapshot (reuse T2c/T3b steps; merged-state cache keeps it cheap).
   - Target: tree updated within **5 s** of the webhook for a normal push.
2. **Recorded parents** (prototype `actions.branch`): on `branch_created` with `after = X`, store every
   existing branch whose head was `X` at that moment (from `Branch` rows before this event) in
   `recordedParents`, plus `recordedAt`. Zero matches (new commits pushed with the branch) → empty list (the
   engine then infers). Choosing among several is the engine's job (`ambiguous`). Never overwrite it later.
3. **Cron fallback** `tree-cron` every 15 min: send `tree/sync-requested` (`cron`) for repos whose
   `RepoGraph.syncedAt` is older than 15 min and were viewed in the last 7 days (track views in Redis from T5c's
   GET, or `RepoGraph.updatedAt`; pick one and say which).
4. Full sync stays the fallback for a `force_push` on the default branch.

## Tests
Push → only that branch refetched; delete → ref removed; create from `feat-a` → `recordedParents = [feat-a]`;
two branches at one commit → both recorded; 10 events in 1 s → one refresh; cron picks only stale viewed repos.

## Not yours
Webhook parsing (T5a), the UI (T5c).

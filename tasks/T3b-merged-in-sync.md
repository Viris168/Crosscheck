# T3b — Merged state in the sync job (Lane B, milestone 3)

**Wave 3** · **Branch:** `feat/t3b-merged-in-sync` · **Lane:** B · **Needs merged:** T2c
**Spec:** `tasks/T-branch-tree.md` → "Merged-state rules", "Privacy rules".
**Mocks until merged:** T3a's `detectMergedWithFallbacks` (signature in `T3a-merged-detection.md`); stub
returns rules 1–2 only.

## You own (edit only these)
- `apps/web/src/server/jobs/tree-sync.ts` (+ test), `jobs/deps.ts`

## Do
1. New step `merged` between `ci` and `snapshot`: call `detectMergedWithFallbacks` with a fresh
   `gitAuthForInstallation`. Step output: `{ checked, merged, byVia: { pr, ancestor, patch_id, content } }`.
2. Feed the result into `buildSnapshot`.
3. Cache: keep a Redis hash `tree:merged:<repoId>` of `branch@headSha@targetSha → via|none` (TTL 7 d) so
   rules 3–4 run once per branch head; only ids/SHAs in it.
4. A workspace failure never fails the sync: log `{ repoId, reason }`, leave those branches unmerged.

## Done when (milestone 3, on a real test repo — write the steps in the PR)
Make a throwaway repo with three PRs merged by merge commit, squash and rebase, plus one branch of each
kind merged **without** a PR. After a sync, all six show merged; the three PR ones say "merged via #n".

## Tests
Step order; cache hit skips the workspace; workspace error → sync still `ready`; step output has no names.

## Not yours
The engine (T3a), the UI labels (already in T2d).

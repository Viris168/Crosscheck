# T4 — Compare-with on real data: "why" label + overrides (Lane F, milestone 4)

**Wave 3** · **Branch:** `feat/t4-compare-with` · **Lane:** F · **Needs merged:** T2d
**Spec:** `tasks/T-branch-tree.md` → "Compare-with rules", "Contracts → API" (PUT compare-with).

## You own (edit only these)
- `apps/web/src/app/api/repos/[repoId]/tree/compare-with/route.ts` (new) + test
- `apps/web/src/app/api/repos/[repoId]/tree/route.ts` (apply overrides), `components/tree/**`, `hooks/use-tree.ts`

## Do
1. **PUT `/tree/compare-with`**: `requireSession` + `requireRepoWrite`. Validate that `branch` and
   `compareWith` exist (non-deleted `Branch` rows), are different, and would not make a cycle (use
   `pickCompareWith` from `@app/git-graph` with the new override to check). Upsert / delete the
   `CompareOverride` row. Return the recomputed `BranchNode`.
2. **Recompute without a sync**: overrides must show immediately. In GET `/tree`, re-run `pickCompareWith`
   + `aheadBehind` on the stored snapshot's commit graph with the current overrides (pure, in-memory).
3. **UI**:
   - A "why" label on each row: Override · Open PR #n · Merged PR #n · Recorded · Nearest branch ·
     Same commit as X · Default. Tooltip with one sentence per rule.
   - One-click fix: a menu on the compare-with name listing the other branches (nearest first) + "Reset to
     automatic". Hidden when `canEdit` is false. Optimistic update, rollback on error.
4. Log `{ repoId, whyBefore }` on each override (no branch names) so the team can see which rule picks wrong.

## Done when (milestone 4)
On 2–3 real repos the team reviews every branch; write in the PR how many picks were right and which rule
picked the wrong ones. Each wrong one fixed with one menu click.

## Tests
403 without write, 400 on cycle / unknown branch / self, override survives a sync, reset removes it,
optimistic rollback.

## Not yours
Changing the rule order in the engine (ask lane T via `tasks/CONTRACT_REQUESTS.md` if the check shows a rule
is wrong).

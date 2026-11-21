# T8b — Timeline slider + before/after view (Lane F, milestone 8, optional)

**Wave 7** · **Branch:** `feat/t8b-time-travel-ui` · **Lane:** F · **Needs merged:** T7
**Spec:** `tasks/T-branch-tree.md` → "Milestones" row 8.
**Mocks until merged:** T8a's `snapshotAt(repoId, at)` (signature in `T8a-snapshots.md`).

## You own (edit only these)
- `apps/web/src/components/tree/**`, `apps/web/src/hooks/use-tree.ts`,
  `apps/web/src/app/api/repos/[repoId]/tree/route.ts`

## Do
1. GET `/tree?at=<ISO>` → `snapshotAt`; no `at` = live (unchanged).
2. **Timeline slider** under the header: range from the first `GitEvent` to now, tick marks per event
   (pushes, merges, creates/deletes). Dragging shows that moment (live polling pauses; "Back to live" button).
   `?at=` in the URL so a moment can be shared.
3. **Before/after**: pick two moments → side-by-side (or overlay with diff colours): branches added, deleted,
   moved (ahead/behind change), newly merged.
4. Keyboard: ←/→ step between events.

## Tests
`at` round-trips through the URL; slider steps hit event times; diff view lists added/removed/moved correctly
for a fixture pair of snapshots.

## Done when (milestone 8)
Any two moments since recording started can be compared on a real test repo.

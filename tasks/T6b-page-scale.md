# T6b — Page at scale: collapse, search, filter, on-demand compare (Lane F, milestone 6)

**Wave 5** · **Branch:** `feat/t6b-page-scale` · **Lane:** F · **Needs merged:** T5c
**Spec:** `tasks/T-branch-tree.md` → "Milestones" row 6, "Contracts → API" (GET `/tree/compare`).
**Mocks until merged:** T6a's `compare()` and `buildSnapshot({ visible })` (signatures in `T6a-engine-scale.md`).

## You own (edit only these)
- `apps/web/src/components/tree/**`, `apps/web/src/hooks/use-tree.ts`,
  `apps/web/src/app/api/repos/[repoId]/tree/route.ts`, `.../tree/compare/route.ts` (new) + tests

## Do
1. **Virtualized list** (`@tanstack/react-virtual`): only visible rows render. Send the visible branch names
   to GET `/tree?visible=` (debounced 150 ms) so the server computes only those (T6a lazy table). Add
   `visible` to `GetTreeQuery` via `tasks/CONTRACT_REQUESTS.md` (local `.extend()` until applied).
2. **Collapse**: subtrees collapse/expand; long linear runs of commits in the lane graph collapse to "… 120
   commits" and expand on click. Merged branches collapsed by default.
3. **Search and filter**: name search (client side), filters: mine (PR author = me), open PR, CI failing,
   merged, stale (> 30 days). Filters live in the URL (`?q=&f=`).
4. **Any two branches**: select two rows → GET `/tree/compare?a=&b=` → ahead/behind/merge-base panel.
   View access; Redis cache 60 s keyed by both head SHAs.
5. Respect T6a's budget: measure with the 500-branch generated repo seeded locally (add a dev-only seed
   script under `apps/web/scripts/` if needed) and put the numbers in the PR.

## Tests
Virtualization renders < 60 rows for 500 branches; filters in URL round-trip; compare route auth + cache.

## Done when (milestone 6)
500 branches / 50k commits: first paint and scrolling stay within the budget T6a wrote down.

## Not yours
Engine performance (T6a).

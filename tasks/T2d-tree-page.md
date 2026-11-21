# T2d — Branches tab, tree API and read-only page (Lane F, milestone 2)

**Wave 2** · **Branch:** `feat/t2d-tree-page` · **Lane:** F · **Needs merged:** T0
**Spec:** `tasks/T-branch-tree.md` → "Contracts → API", "Goal". UI reference: the prototype.
**Mocks until merged:** the seed `RepoGraph` snapshot (T0); `requestTreeSync` from `@/server/jobs` (T2c) —
until it exists, call `inngest.send({ name: 'tree/sync-requested', ... })` directly.

## You own (edit only these)
- `apps/web/src/app/(dashboard)/repos/[repoId]/repo-header.tsx` (add the tab only)
- `apps/web/src/app/(dashboard)/repos/[repoId]/tree/**` (new)
- `apps/web/src/app/api/repos/[repoId]/tree/route.ts`, `.../tree/sync/route.ts` (new)
- `apps/web/src/components/tree/**` (new), `apps/web/src/hooks/use-tree.ts` (new), `apps/web/src/lib/query-keys.ts`

## Do
1. **Tab**: `{ href: \`${base}/tree\`, label: 'Branches', active: active === 'tree' }` between Pull requests
   and Settings; add `'tree'` to the `active` union.
2. **GET `/api/repos/:repoId/tree`**: `requireSession` + `requireRepoAccess`; read `RepoGraph` (+ `canEdit`
   via `canEditRepo`). If there is no `RepoGraph`, send `tree/sync-requested` (`first_view`) and return
   `{ status: 'syncing', snapshot: null }`. Parse with `GetTreeResponse` before returning.
3. **POST `/api/repos/:repoId/tree/sync`**: view access; Redis rate limit 1/min/repo → 429; sends the event.
4. **Page** `tree/page.tsx`: `loadRepoForPage` + `<RepoHeader active="tree" />` + a client `<BranchTree>`.
   - `useTree(repoId)`: TanStack Query; poll every 3 s while `status === 'syncing'`, else no polling (T5c
     changes this).
   - Render: one row per branch, drawn as a tree by `compareWith` (default branch at the root). Each row:
     name, `ahead ↑ / behind ↓` vs its compare-with, PR chip (`#n open/merged`), CI dot, "merged via #n" when
     `merged` is set, "same commit as X" label. A small commit lane graph from `snapshot.commits` (port the
     prototype's drawing).
   - States: syncing (skeleton + "Cloning commits…"), failed (error + "Try again" → POST sync), empty
     (only the default branch), `truncated` banner.
   - A "Refresh" button → POST sync.
5. Keyboard: rows are focusable; Enter on a row with a PR opens `/repos/:id/pulls/:n`.

## Tests
- Route tests: 401 no session, 404 not a collaborator, first view sends the event once, 429 rate limit,
  response validates against `GetTreeResponse`.
- Component tests with the seed snapshot: stacked branch nests under its parent; merged and same-commit
  labels render; failed state shows retry.
- Screenshot in the PR of the seed repo's Branches tab.

## Not yours
Compare-with overrides and the "why" label (T4), live updates (T5c), collapse/search (T6b).

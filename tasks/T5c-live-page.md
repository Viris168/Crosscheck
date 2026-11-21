# T5c — Live tree page (Lane F, milestone 5)

**Wave 4** · **Branch:** `feat/t5c-live-page` · **Lane:** F · **Needs merged:** T2d, T4
**Spec:** `tasks/T-branch-tree.md` → "Milestones" row 5.

## You own (edit only these)
- `apps/web/src/components/tree/**`, `apps/web/src/hooks/use-tree.ts`, `apps/web/src/app/api/repos/[repoId]/tree/route.ts`

## Do
1. **Live**: poll GET `/tree` every 3 s while the tab is visible (`refetchIntervalInBackground: false`), with
   `If-None-Match` on `syncedAt` (ETag) so unchanged trees return 304. Stop polling after 10 min idle; resume
   on focus. (Stack rule: polling, no websockets.)
2. **Change highlight**: rows whose `headSha` changed since the last render flash for 2 s; new branches slide
   in; deleted ones fade out.
3. **"Recorded" badge** when `recorded` is true, tooltip "Parent recorded when the branch was created".
4. "Last updated Xs ago" next to Refresh.
5. If `GitEvent`s are missing for the repo (App not subscribed yet), show a one-line hint linking to the
   App permissions doc.

## Tests
304 path; highlight on head change; recorded badge; polling stops when hidden.

## Done when (milestone 5, with T5a + T5b merged)
Push to a branch on a test repo → the row updates within seconds. Create a branch from another → it shows
"recorded" under the right parent. Record a short screen capture for the PR.

## Not yours
Collapse / search (T6b).

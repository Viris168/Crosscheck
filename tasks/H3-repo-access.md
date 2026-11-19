# H3 — Repo read/write access from GitHub (lane F)

**Wave 2** · **Branch:** `feat/h3-repo-access` · **Lane:** F · **Needs merged:** H0, H1
**Spec:** `tasks/H-repo-collaborators.md` → Access policy, Part 5.1–5.5.

## You own (edit only these)
- `apps/web/src/lib/server/access.ts`, `apps/web/src/lib/server/overview.ts` (+ `overview.test.ts`)
- `apps/web/src/app/api/repos/**` (all repo, pull, settings, token, setup and merge routes)
- `apps/web/src/app/api/reviews/**`, `apps/web/src/app/api/orgs/[orgId]/overview/`
- `apps/web/src/app/api/dashboard-routes.test.ts`
- `apps/web/src/app/(dashboard)/repos/[repoId]/settings/page.tsx`, `apps/web/src/components/settings/**`,
  `apps/web/src/hooks/use-repos.ts`

## Do
1. **`access.ts`** (Part 5.1): `requireRepoAccess` checks **read**, new `requireRepoWrite` checks **write**,
   new `visibleRepoIds(userId, orgId)`. Owner/admin skip GitHub. No `login` → 403 "Link your GitHub account".
   GitHub error on a single repo → 502 `github_error`. Use `getRepoPermission` and `permissionAtLeast` from
   `@/server/github`. Drop the `roles` parameter.
2. `requirePullAccess` and `requireReviewAccess` go through `requireRepoAccess`.
3. **Write routes** → `requireRepoWrite`: `settings` PUT, `ingest-token/rotate`, `setup/workflow-pr`,
   `pulls/[number]/merge`.
4. **Lists:** `GET /api/repos` returns only `visibleRepoIds`; `getOverview` takes the visible repo ids and
   counts only those (repos, open PRs, reviews, issues).
5. **`canEdit`:** the settings GET computes it the same way as `requireRepoWrite`, but without throwing
   (false on a GitHub error). The settings form and ingest-token card disable their controls when it's false,
   with a tooltip: "You need write access to this repository on GitHub."

## Tests
- Every "Routes" case under "Tests" in the spec, except Members (H4 has its own test file).
- Mock `@/server/github` `getRepoPermission` in route tests; assert owner/admin never call it.
- `pnpm --filter @app/web test -- src/lib src/app/api`, then `pnpm turbo lint typecheck`.

## Not yours
Members page and routes (H4), `no-org.tsx` and `/api/me` (H5b), nav (H4).

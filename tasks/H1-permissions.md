# H1 — GitHub permission helpers + cache (lane A)

**Wave 1** · **Branch:** `feat/h1-permissions` · **Lane:** A · **Needs merged:** nothing
**Spec:** `tasks/H-repo-collaborators.md` → Parts 1 and 2.

## You own (edit only these)
- `packages/github/src/permissions.ts` (new) + `permissions.test.ts`, `packages/github/src/index.ts`
- `apps/web/src/server/github/permissions.ts` (new) + `permissions.test.ts`, `apps/web/src/server/github/index.ts`

## Do
1. **`@app/github`:** `RepoPermission`, `fetchRepoPermission`, `isRepoCollaborator`, `fetchOrgMembership`,
   `listUserInstallationIds`, `permissionAtLeast`, exactly as typed in Part 1.
   - `listUserInstallationIds(userToken)` builds its own Octokit from the user token (no app JWT) and pages
     through `GET /user/installations`.
   - 404 handling per Part 1; everything else through `toGithubError`. A 403 must reach the caller as an error
     whose status H2 can read (H2 sets `needsMemberPermission` on it); document how in the JSDoc.
2. **`@/server/github`:** `getRepoPermission` and `invalidateRepoPermission` with the Redis cache from Part 2,
   using `getRedis()` from `@/server/redis` and the installation Octokit from `@app/github`. Re-export
   `RepoPermission` and `permissionAtLeast`.
3. You don't need any contract change: `RepoPermission` lives in `@app/github`.

## Tests
- Every case listed under "Tests" for `packages/github` and `server/github/permissions` in the spec.
- `pnpm turbo test --filter @app/github` and `pnpm --filter @app/web test -- src/server/github`.

## Not yours
Membership sync and webhooks (H2), route checks (H3). Don't edit `handlers.ts` or `webhook.ts`.

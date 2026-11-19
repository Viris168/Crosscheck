# H2 — Membership sync + webhooks (lane A)

**Wave 2** · **Branch:** `feat/h2-membership` · **Lane:** A · **Needs merged:** H0, H1
**Spec:** `tasks/H-repo-collaborators.md` → Part 3 (the sync function), Part 4, "Who becomes what".

## You own (edit only these)
- `apps/web/src/server/github/membership.ts` (new) + `membership.test.ts`
- `apps/web/src/server/github/handlers.ts`, `webhook.ts`, `payloads.ts`, `index.ts`, `index.test.ts`,
  `__fixtures__/`

## Do
1. **`syncUserMemberships(userId)`** exactly as in Part 3:
   - Candidates = `listUserInstallationIds` (user token via `auth.api.getAccessToken`, `// VERIFY:`) ∪ the
     installations of orgs the user is already a member of. No user token → removals only.
   - Decide with the installation token: `fetchOrgMembership` for org installs, account login or
     `isRepoCollaborator` for personal installs. **Never** `fetchRepoPermission !== 'none'` (public repos say
     `read` for everyone).
   - Null `githubAccountType` → skip. Errors → skip, change nothing. 403 on the org call → set
     `Installation.needsMemberPermission = true`.
   - "Has no owner" check + create in one `prisma.$transaction`, upsert on `organizationId_userId`.
   - Returns `{ joined, left }` as org ids. Logs `{ userId, orgId }` only.
2. **`ensureOrganization`:** take `account.type` and store `githubAccountType` (also on existing orgs).
   Keep the current "sender becomes owner if there are no members" behaviour.
3. **`installation.new_permissions_accepted`:** also clear `needsMemberPermission` on that installation.
4. **Webhooks** (Part 4): add `organization` and `member` handlers with zod payloads. Note the user id is at
   `membership.user.id` for `organization` events and `member.id` for `member` events. Unknown users are a
   no-op. `member.*` on a personal install also calls `syncUserMemberships`.
5. Export `syncUserMemberships` from `index.ts`.

## Tests
- Every `server/github/membership` and webhook case under "Tests" in the spec, using the existing
  `__fixtures__/fake-db.ts` style and msw/nock for GitHub.
- `pnpm --filter @app/web test -- src/server/github`.

## Not yours
The Inngest function that calls the sync (H5a), the Check again route (H5b), access checks (H3).

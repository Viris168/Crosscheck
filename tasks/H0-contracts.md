# H0 — Contracts + Better Auth hardening (Foundation)

**Wave 1** · **Branch:** `feat/h0-contracts` · **Lane:** Foundation · **Needs merged:** nothing
**Spec:** `tasks/H-repo-collaborators.md` → "Contract changes", "Better Auth hardening", Part 3 "Where it runs".

## You own (edit only these)
- `packages/shared/src/events.ts` (+ `events.test.ts`)
- `packages/shared/src/api/orgs.ts`, `packages/shared/src/api/repos.ts`, `packages/shared/src/api/index.ts`
  (+ `api.test.ts`)
- `packages/db/prisma/schema.prisma` + one new migration in `packages/db/prisma/migrations/`
- `packages/db/prisma/seed.ts` (set `githubAccountType: 'Organization'` on the seed org)
- `apps/web/src/server/auth.ts` (+ `auth.test.ts`)
- `tasks/CONTRACT_REQUESTS.md` (one entry per change, status "applied")

## Do
1. **Event:** `'user/signed-in': { userId: string }` in both `events` and `eventSchemas`.
2. **Schema + migration** (`pnpm db:migrate --name h_members_from_github`):
   - `Organization.githubAccountType String?` (`'Organization' | 'User'`)
   - `Installation.needsMemberPermission Boolean @default(false)`
   - If `Organization` fields are mirrored in Better Auth's `organization.schema.additionalFields`, add
     `githubAccountType` there too (`input: false`).
3. **API schemas** in `api/orgs.ts`: `MemberParams { orgId, memberId }`,
   `OrgMemberSchema { id, userId, login: string|null, name, avatarUrl: string|null, role: MemberRole }`,
   `ListMembersResponse { members: OrgMemberSchema[], needsMemberPermission: boolean }`,
   `UpdateMemberBody { role: MemberRole }`, `UpdateMemberResponse { member: OrgMemberSchema }`,
   `SyncOrgsResponse { joined: string[], left: string[] }` (org ids).
   In `api/repos.ts`: `canEdit: boolean` on the repo settings GET response. Export everything from
   `@app/shared` and the browser-safe ones from `@app/shared/client`.
4. **`auth.ts`:**
   - `databaseHooks.session.create.after`: `await inngest.send({ name: 'user/signed-in', data: { userId } })`
     from `@/server/jobs`, inside try/catch. A failed send logs `{ userId }` and never blocks sign-in.
     Load it lazily inside the hook (`const { inngest } = await import('@/server/jobs')`): after H2/H5a the
     chain jobs → github → auth would otherwise be a circular import.
   - GitHub provider: `overrideUserInfoOnSignIn: true` (so `login`/`avatarUrl` follow GitHub renames).
   - `organization({ allowUserToCreateOrganization: false, ... })`.
   - `disabledPaths`: every `/organization/*` endpoint that creates, updates or deletes orgs, members,
     invitations or teams. **Keep `/organization/set-active`** (org switcher) and the read-only endpoints.
     Get the real list from `node_modules/better-auth/dist/plugins/organization` for the installed 1.7.x.
   - `account: { encryptOAuthTokens: true }`. Check how existing plaintext rows behave.
   - Mark every option you weren't sure of with `// VERIFY:`.

## Tests
- `events.test.ts` and `api.test.ts`: new schemas parse and reject bad input.
- `auth.test.ts`: the hook sends `user/signed-in` with `{ userId }` only; a throwing `inngest.send` doesn't
  throw out of the hook.
- With the dev server running, POST `/api/auth/organization/{create,invite-member,remove-member,update-member-role}`
  returns 404 and `/organization/set-active` still answers. Put this in the PR description.
- `pnpm turbo lint typecheck test` passes; `pnpm db:migrate` and `pnpm db:seed` work on a fresh database.

## Not yours
Anything that uses the new contracts (H1–H5). Don't set `githubAccountType` in `ensureOrganization`; H2 does.

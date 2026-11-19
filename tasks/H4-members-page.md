# H4 — Settings → Members page (lane F)

**Wave 2** · **Branch:** `feat/h4-members-page` · **Lane:** F · **Needs merged:** H0
**Spec:** `tasks/H-repo-collaborators.md` → Part 5.6, "Who becomes what".

## You own (edit only these)
- `apps/web/src/app/(dashboard)/settings/members/` (new page)
- `apps/web/src/app/api/orgs/[orgId]/members/` (new routes) + `members-routes.test.ts` next to them
- `apps/web/src/components/members/` (new), `apps/web/src/hooks/use-members.ts` (new)
- `apps/web/src/components/shell/nav-links.tsx` (add Members under Settings)

## Do
1. **`GET /api/orgs/[orgId]/members`** (any member): `ListMembersResponse` with `login`, `name`, `avatarUrl`
   from `User`, plus `needsMemberPermission` = any of the org's installations has the flag.
2. **`PATCH /api/orgs/[orgId]/members/[memberId]`** (`owner` only, `UpdateMemberBody`): set any role.
   Refuse (409) when the change would leave the org with no owner. The member must belong to `orgId` (404).
3. **Page:** member list (avatar, login, role). The owner gets a role select per row; others see read-only.
   No Add/Remove buttons. Show "Members come from GitHub. Add or remove people in your GitHub organization."
   Banner for the owner when `needsMemberPermission`: "Accept the new GitHub App permissions to sync members."
4. Nav: the Settings area has both Connections and Members; keep the current active-link matching working.
5. Use `apiFetch` + TanStack Query like the other hooks; schemas from `@app/shared/client`.

## Tests
- Members routes: any member can list; non-member 403; PATCH by admin/member 403; owner can promote,
  demote and transfer; demoting the last owner 409; member of another org 404.
- `pnpm --filter @app/web test -- src/app/api/orgs`, then `pnpm turbo lint typecheck`.

## Not yours
`lib/server/access.ts`, repo routes and `dashboard-routes.test.ts` (H3), the sync itself (H2).

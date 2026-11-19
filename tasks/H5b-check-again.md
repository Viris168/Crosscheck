# H5b — "Check again" on the No organization page (lane F)

**Wave 3** · **Branch:** `feat/h5b-check-again` · **Lane:** F · **Needs merged:** H0, H2
**Spec:** `tasks/H-repo-collaborators.md` → Part 3 "Where it runs", Part 5.7.

## You own (edit only these)
- `apps/web/src/app/api/me/sync-orgs/route.ts` (new) + test
- `apps/web/src/app/(dashboard)/no-org.tsx` (+ a small client component next to it if needed)

## Do
1. **`POST /api/me/sync-orgs`:** `requireSession`, then rate limit with `getRedis()` from `@/server/redis`
   (key `rl:sync-orgs:{userId}`, 5 per 60s, 429 `rate_limited` after; if Redis is down, allow). Run
   `syncUserMemberships(session.user.id)` from `@/server/github` inline and return `SyncOrgsResponse`.
2. **`no-org.tsx`:** a **Check again** button. On success with `joined.length > 0`, refresh the page
   (`router.refresh()`) so the dashboard shows the org. Otherwise show "Still no organization. Ask your
   GitHub org admin to install the app, or check that you're a member on GitHub."
3. Keep the existing Install button on that page working.

## Tests
- Route: 401 without a session; calls the sync with the session's user id; 429 on the 6th call in a minute;
  Redis down still works.
- `pnpm --filter @app/web test -- src/app/api/me`, then `pnpm turbo lint typecheck`.

## Not yours
The sync logic (H2), the Members page and nav (H4).

# H5a — Sign-in membership sync job (lane B)

**Wave 3** · **Branch:** `feat/h5a-signin-job` · **Lane:** B · **Needs merged:** H0, H2
**Spec:** `tasks/H-repo-collaborators.md` → Part 3 "Where it runs".

## You own (edit only these)
- `apps/web/src/server/jobs/` (new `member-sync.ts` + test, `functions.ts`, `index.ts`)

## Do
1. Inngest function `member-sync`, triggered by `user/signed-in`, that calls `syncUserMemberships(userId)`
   from `@/server/github` inside a `step.run`.
2. `concurrency: { key: 'event.data.userId', limit: 1 }` so two sign-ins don't sync the same user at once.
   Retries: the default is fine (the sync is safe to repeat).
3. Register it in the `functions` array. Log `{ userId, joined: n, left: n }`, never logins or tokens.

## Tests
- The function calls the sync with the event's `userId`; a thrown error is retried (follow the
  existing `review-*.test.ts` style).
- `pnpm --filter @app/web test -- src/server/jobs`. With the dev stack up, the Inngest UI
  (http://localhost:8288) shows 4 functions.

## Not yours
The hook that sends the event (H0), the sync logic (H2).

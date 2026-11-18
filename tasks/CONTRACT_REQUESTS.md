# Contract change requests

Agents: do NOT edit `packages/shared` or `packages/db` directly. Add a request here and continue with a
local workaround. The owner applies approved changes on `main`; then rebase.

## Template
### [Lane X] Short title
- **Change:** what to add/modify (paste the exact type or Prisma field)
- **Why:** what breaks or is impossible without it
- **Workaround in use:** what you did meanwhile
- **Status:** open | applied | rejected

---

### [Lane F] Cancel a queued review (gap from Foundation PR #1)
- **Change:** a cancel endpoint plus a way to record the cancellation. Proposal:
  ```ts
  // packages/shared/src/enums.ts — add a terminal status (and the same value to the Prisma enum)
  export const ReviewStatus = ['queued', 'running', 'waiting_action', 'completed', 'failed', 'cancelled'] as const;

  // packages/shared/src/api/reviews.ts
  /** POST /api/reviews/:id/cancel — only `queued` (and `waiting_action`?) reviews; 409 otherwise. */
  export const CancelReviewResponse = z.object({ reviewId: Id, status: z.enum(ReviewStatus) });
  ```
  Also list `POST /api/reviews/:id/cancel` in `docs/tech-stack.md` → Endpoints. Lane B's `review-start`
  must then skip reviews that are no longer `queued` (it should re-read the status in its first step).
  Alternative if a new status is unwanted: `status: 'failed'` + a new `ErrorCode` `'cancelled'`.
- **Why:** `tasks/F-frontend.md` puts a **Cancel** action on the `queued` state, but there is no endpoint,
  and no status or error code that can represent "cancelled by the user".
- **Workaround in use:** the Cancel button is rendered disabled with the note "Cancelling a queued review
  isn't available yet" (`apps/web/src/components/review/review-states.tsx`).
- **Status:** open

### [Lane F] ChatGPT connection status (gap from Foundation PR #1)
- **Change:** a read endpoint next to the existing `DELETE`:
  ```ts
  // packages/shared/src/api/connections.ts
  /** GET /api/connections/chatgpt — the current user's connection in the current (active) org. Never returns tokens. */
  export const GetChatGptConnectionResponse = z.object({
    connected: z.boolean(),
    orgId: Id.nullable(),
    connectedAt: IsoDate.nullish(),
    expiresAt: IsoDate.nullish(),
  });
  ```
  Also list `GET /api/connections/chatgpt` in `docs/tech-stack.md` → Endpoints.
- **Why:** `/settings/connections` and setup wizard step 3 (Codex · ChatGPT) must show Connected / Not
  connected and choose between "Sign in with ChatGPT" and "Disconnect". Without a GET the page can't know.
- **Workaround in use:** the route `apps/web/src/app/api/connections/chatgpt/route.ts` implements `GET`
  with this exact schema, defined locally in `apps/web/src/lib/pending-contracts.ts`. Once applied, swap
  the import to `@app/shared` and delete the local schema.
- **Status:** open

### [Lane F] Review history + single-review read on the PR page
- **Change:**
  ```ts
  // packages/shared/src/api/reviews.ts
  export const ReviewSummarySchema = z.object({
    id: Id, status: z.enum(ReviewStatus), provider: z.enum(ProviderId),
    headSha: z.string(), stale: z.boolean(), createdAt: IsoDate,
  });
  // packages/shared/src/api/pulls.ts — GetPullResponse gains:
  reviews: z.array(ReviewSummarySchema), // every review of the PR, newest first
  ```
  And list `GET /api/reviews/:id` (response `ReviewDetailSchema`, params `ReviewParams` — both already in
  `@app/shared`) in `docs/tech-stack.md` → Endpoints. `useReview(id)` in the task file needs it to poll.
- **Why:** `GetPullResponse` carries only the latest review, so older reviews (and, with the seed data,
  four of the five states) can't be opened, and `useReview(id)` has no endpoint to poll.
- **Workaround in use:** `GetPullWithHistoryResponse = GetPullResponse.extend({ reviews })` in
  `apps/web/src/lib/pending-contracts.ts`; `GET /api/reviews/:id` is implemented with the shared schemas.
- **Status:** open

### [Lane F] Last review status on the repo list
- **Change:** `RepoSchema` (or `ListReposResponse` items) gains
  `lastReview: LatestReviewSummarySchema.nullish()` — the latest review of the most recently updated PR.
- **Why:** the `/repos` page shows "last review status" per repo (`tasks/F-frontend.md` → Pages).
- **Workaround in use:** `RepoWithLastReviewSchema = RepoSchema.extend({ lastReview })` in
  `apps/web/src/lib/pending-contracts.ts`, returned by `GET /api/repos`.
- **Status:** open

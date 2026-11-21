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

### [Lane C] Optional model env vars in `.env.example` / turbo `globalPassThroughEnv`
- **Change:** add these optional vars to `.env.example` and to `globalPassThroughEnv` in `turbo.json`:
  ```
  PLATFORM_MODEL=              # default claude-opus-5-5
  PLATFORM_EFFORT=             # low|medium|high|xhigh|max, default medium
  OPENAI_MODEL=                # platform fallback, default gpt-5
  CHATGPT_MODEL=               # codex_chatgpt, default gpt-5-codex
  ```
- **Why:** `@app/providers` reads them to override default models without a code change.
- **Workaround in use:** hard-coded defaults in `packages/providers` are used when the vars are unset.
- **Status:** applied (PR chore/contract-requests)

### [Lane C] Pass the repo's model to providers
- **Change:** add `model?: string` to `ProviderContext` (or `ReviewChunkInput`) in `packages/shared/src/provider.ts`.
- **Why:** "Model from repo settings" otherwise needs a DB lookup inside the provider.
- **Workaround in use:** the `platform` provider looks up `repo.settings.model` via `@app/db` (`orgId` + `fullName`).
- **Status:** applied (PR chore/contract-requests) — `ProviderContext.model`; the DB lookup stays as a fallback when it is unset

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
- **Status:** applied (PR chore/contract-requests)

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
- **Status:** applied (PR chore/contract-requests)

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
- **Status:** applied (PR chore/contract-requests)

### [Lane F] Last review status on the repo list
- **Change:** `RepoSchema` (or `ListReposResponse` items) gains
  `lastReview: LatestReviewSummarySchema.nullish()` — the latest review of the most recently updated PR.
- **Why:** the `/repos` page shows "last review status" per repo (`tasks/F-frontend.md` → Pages).
- **Workaround in use:** `RepoWithLastReviewSchema = RepoSchema.extend({ lastReview })` in
  `apps/web/src/lib/pending-contracts.ts`, returned by `GET /api/repos`.
- **Status:** applied (PR chore/contract-requests)

### [Lane B] Carry the AI's own risk score from review-start / ingest to review-finalize
- **Change:** add a nullable column to `Review` in `packages/db/prisma/schema.prisma` (+ migration):
  ```prisma
  /// The provider's own risk_score (max over chunks, or the Action's result). Input to computeRisk.
  aiRiskScore Int?
  ```
- **Why:** `review-finalize` runs as a separate function and needs `aiScores` for `computeRisk`, but
  step outputs / events may carry ids only. There is no field for the AI score before scoring.
- **Workaround in use:** review-start writes the AI score (max over chunks) to `Review.riskScore`;
  review-finalize reads it as `aiScores: [riskScore]` and then overwrites it with the computed score.
  **Lane D:** until this lands, ingest should also save `result.risk_score` into `riskScore` (and
  `result.summary` into `summary`) before sending `review/finalize`.
- **Status:** applied (PR #9 adds `Review.aiRiskScore`; jobs + ingest use it since fix/wave2-wiring)

### [Lane G] Next.js `output: 'standalone'` for the production image
- **Change:** in `apps/web/next.config.ts` add `output: 'standalone'` (keep `outputFileTracingRoot: repoRoot`,
  which makes the traced output contain `apps/web/server.js` + only the needed `node_modules`).
  If Prisma's query engine is missing from the trace at runtime, also add
  `outputFileTracingIncludes: { '/**': ['../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**'] }`.
- **Why:** `tasks/G-infra.md` asks for a standalone, slim web image. Without it the image has to ship the
  whole pruned workspace (all `node_modules`, incl. dev deps) and run `next start`.
- **Workaround in use:** `infra/docker/web.Dockerfile` detects `.next/standalone/apps/web/server.js`; when it
  is missing it falls back to `next start` from the pruned workspace. Nothing else changes when this lands.
- **Status:** open

### [Lane G] Point `.env.example` at the production template
- **Change:** one comment line in `.env.example`:
  `# Production: see infra/env.prod.example (adds DOMAIN, POSTGRES_PASSWORD) and docs/deploy.md`.
- **Why:** prod needs two infra-only vars that aren't in `.env.example`; avoids people hunting for them.
- **Workaround in use:** `infra/env.prod.example` + `docs/deploy.md` §5.
- **Status:** open

### [Task H] Event `user/signed-in`
- **Change:** `'user/signed-in': { userId: string }` in `events` and `eventSchemas` (`packages/shared/src/events.ts`).
- **Why:** the sign-in hook triggers the membership sync job (H5a).
- **Workaround in use:** none.
- **Status:** applied (PR feat/h0-contracts)

### [Task H] `Organization.githubAccountType` + `Installation.needsMemberPermission`
- **Change:** `githubAccountType String?` on `Organization` (also a Better Auth org `additionalFields` entry,
  `input: false`); `needsMemberPermission Boolean @default(false)` on `Installation`. Migration
  `h_members_from_github`. Seed org gets `githubAccountType: 'Organization'`.
- **Why:** membership sync needs the install type; the Members page shows the "accept permissions" banner.
- **Workaround in use:** none.
- **Status:** applied (PR feat/h0-contracts)

### [Task H] Members API schemas
- **Change:** `MemberParams`, `OrgMemberSchema`, `ListMembersResponse`, `UpdateMemberBody`,
  `UpdateMemberResponse`, `SyncOrgsResponse` in `packages/shared/src/api/orgs.ts`.
- **Why:** Members page (H4) and `POST /api/me/sync-orgs` (H5b).
- **Workaround in use:** none.
- **Status:** applied (PR feat/h0-contracts)

### [Task H] `canEdit` on the repo settings GET response
- **Change:** `canEdit: z.boolean().default(false)` on `GetRepoSettingsResponse` (`api/repos.ts`). The default
  keeps today's handler compiling and fails closed in the UI until H3 sets it.
- **Why:** the settings page disables edit controls for read-only collaborators (H3).
- **Workaround in use:** none.
- **Status:** applied (PR feat/h0-contracts)

### [Task H] Better Auth hardening + sign-in hook (`apps/web/src/server/auth.ts`)
- **Change:** `databaseHooks.session.create.after` sends `user/signed-in` (lazy import, never throws);
  `overrideUserInfoOnSignIn: true`; `allowUserToCreateOrganization: false`; `disabledPaths` for every
  org/member/invitation/team/role mutation (keeps `set-active` and reads); `account.encryptOAuthTokens: true`.
- **Why:** GitHub is the only source of members.
- **Workaround in use:** none.
- **Status:** applied (PR feat/h0-contracts)

### [Task H3] `github_error` as a REST `ApiErrorCode` (502)
- **Change:** add `'github_error'` to `ApiErrorCode` with `API_ERROR_STATUS.github_error = 502`
  (`packages/shared/src/api/errors.ts`).
- **Why:** H-spec Part 5.1 says a GitHub error on a single-repo access check returns 502 `github_error`.
- **Workaround in use:** `apps/web/src/lib/server/access.ts` throws
  `new HttpError('github_error' as ApiErrorCode, …, 502)`; drop the cast once this lands.
- **Status:** applied (PR fix/shared-github-error-code; cast removed from `access.ts`)

### [Task T] Branch tree Prisma models + `PullRequest` merge fields
- **Change:** enums `TreeSyncStatus`, `CiState`, `MergedVia`; models `RepoGraph`, `Branch`, `CommitCi`,
  `CompareOverride`, `GitEvent` (back-relations `Repo.graph`, `Repo.branches`); `PullRequest` gains
  `mergedAt`, `mergeCommitSha`, `baseSha`. Migration `t_branch_tree`.
- **Why:** `tasks/T-branch-tree.md` → "Contracts → Prisma".
- **Workaround in use:** none.
- **Status:** applied (PR feat/t0-contracts)

### [Task T] Branch tree enums
- **Change:** `TreeSyncStatus`, `CiState`, `MergedVia`, `CompareWhy` in `packages/shared/src/enums.ts`.
- **Why:** shared by the engine, sync job and page; mirror the Prisma enums.
- **Workaround in use:** none.
- **Status:** applied (PR feat/t0-contracts)

### [Task T] Events `tree/sync-requested` + `tree/refs-changed`
- **Change:** `'tree/sync-requested': { repoId, orgId, reason: 'manual'|'first_view'|'webhook'|'cron' }` and
  `'tree/refs-changed': { repoId, orgId, eventId }` in `events` and `eventSchemas`.
- **Why:** sync job (T2c) and live updates (T5a/T5b). Ids only.
- **Workaround in use:** none.
- **Status:** applied (PR feat/t0-contracts)

### [Task T] Tree API schemas (`packages/shared/src/api/tree.ts`)
- **Change:** `TreeParams`, `BranchNodeSchema`, `TreeSnapshotSchema`, `GetTreeQuery`, `GetTreeResponse`,
  `SyncTreeResponse`, `SetCompareWithBody`, `SetCompareWithResponse`, `CompareQuery`, `CompareResponse`
  (+ `Sha`, `BranchName`, `TREE_MAX_*` caps). Exported from `@app/shared` and `@app/shared/client`.
- **Why:** the four tree endpoints in the T-spec.
- **Workaround in use:** none.
- **Status:** applied (PR feat/t0-contracts)

### [Task T] `REPO_CACHE_DIR` env + seed tree
- **Change:** `REPO_CACHE_DIR=./.cache/repos` in `.env.example` and `apps/web/src/server/env.ts` (optional,
  defaulted); `.cache/` in `.gitignore`. Seed repo gets a `ready` `RepoGraph` mirroring the prototype's
  web-app demo, plus `Branch` and `CommitCi` rows.
- **Why:** T2a/T2c need the cache dir; F builds the page (T2d) before the sync job exists.
- **Workaround in use:** none.
- **Status:** applied (PR feat/t0-contracts)

### [Task T2d] Mark squash commits in `TreeSnapshot`
- **Change:** add `mergeCommitSha: Sha.nullable()` to `BranchMergedSchema` (set when `via = 'pr'`, from
  `PullRequest.mergeCommitSha`). Optional alternative: `squashShas: Sha[]` on `TreeSnapshotSchema`.
- **Why:** the page draws squash commits as squares (prototype `renderTree`). A squash commit has one
  parent, so the graph alone can't tell it apart; the snapshot has the PR's merge method but not which
  commit it produced.
- **Workaround in use:** `layoutTree(snapshot, graph, squashShas)` takes the set; the page passes an empty
  set, so squash commits draw as normal circles until this lands.
- **Status:** applied as `mergeCommitSha: Sha.nullable().default(null)` (PR fix/shared-tree-merge-commit-sha).
  T3a fills it in `@app/git-graph`; T4 passes the squash SHAs to `layoutTree`.

### [Task T5c] `liveEvents` on the GET /tree response
- **Change:** `liveEvents: z.boolean().default(true)` on `GetTreeResponse` (`packages/shared/src/api/tree.ts`):
  false when no `GitEvent` row exists for the repo (the GitHub App is not subscribed to Push/Check/Status yet).
- **Why:** T5c shows a one-line hint linking to the App permissions doc when git events are missing.
- **Workaround in use:** GET /tree sends a `x-tree-live-events: 1|0` response header (also on 304s);
  `useTree` reads it into a client-only `TreeData.liveEvents`. Drop the header once this lands.
- **Status:** requested

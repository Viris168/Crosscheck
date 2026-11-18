# Task B — Review jobs (Inngest functions)

**Branch:** `feat/b-jobs` · **Phase 2** · **Depends on:** Foundation, A, C, E (mock any not yet merged)

## Goal
Run reviews in the background as durable Inngest functions: split big PRs into chunks, call the chosen
provider (one `step.run` per chunk), store issues, update progress, finalize (score + comments), and fail
with a clear `ErrorCode`.

Read first: `docs/tech-stack.md` (Background jobs section). Check the current Inngest TypeScript SDK docs
for `createFunction`, `step.run`, `step.sendEvent`, `concurrency`, `retries`, `NonRetriableError`, cron
triggers; mark assumptions `// VERIFY:`.

## You own
`apps/web/src/server/jobs/` only. Public entry `index.ts` exports `inngest` (client, created by
Foundation in `client.ts`) and `functions` (array served by `/api/inngest`).

## Do not touch
Any `packages/*`, other folders in `apps/web` (including `src/app/api/inngest/route.ts`, which only serves
`functions` from your `index.ts`). You may add dependencies to `apps/web/package.json`.

## Mocks until other lanes merge
- `@app/github` → `src/server/jobs/mocks/github.ts` returning fixture files
- `@app/providers` → `src/server/jobs/mocks/provider.ts` returning a fixed `ReviewChunkResult`
- `@app/scoring` / `@app/github-comments` → no-op mocks
Switch via import only; delete mocks once real packages are merged.

## Build

### Function `review-start` — trigger event `review/requested` `{ reviewId, orgId }`
Settings: `concurrency: { key: 'event.data.orgId', limit: 3 }` (3 reviews at once per org), `retries` per below.
1. `step.run('load')`: load review + PR + repo. If status is not `queued` (e.g. the user `cancelled` it), return (idempotent).
2. `step.run('mark-running')`: set `running`, `startedAt`.
3. `step.run('plan')`: fetch PR files (`fetchPullRequestFiles`). Drop: removed files, binary/no patch,
   `repo.settings.ignorePaths`, secret-like files (`.env*`, `*.pem`, `*.key`), lockfiles.
   Load context: PR body, `CHANGE_NOTES.md` and `AGENTS.md` at head (via `fetchFileText`).
   **Chunking:** estimate tokens (chars / 4). Pack files into chunks ≤ ~60k tokens each. A single file larger
   than the limit is truncated to its first hunks with a note. If total > 400k tokens, keep the
   highest-risk files first (paths matching auth, payment, migration, security, config) and record a
   `too_large` *warning* (review still completes). Set `filesTotal`.
   **Return only file paths per chunk** (step outputs are persisted by Inngest — never return patches).
4. **One `step.run('chunk-<i>')` per chunk**, 3 in parallel (batches of `Promise.all`). Each step re-fetches
   its files' patches, calls `getProvider(repo.provider).reviewChunk(input, { orgId, model: repo.settings.model })`, inserts issues, increments
   `filesDone`, and returns counts only. Make each chunk step idempotent (delete that chunk's issues before
   insert, or use a `[reviewId, chunkIndex]` marker).
5. Retries by `ProviderError.code`: `timeout` / `rate_limited` → retry (max 2); `invalid_output` → retry
   once (check `attempt`); `provider_auth` → throw `NonRetriableError`. Catch a chunk's final failure so the
   other chunks still run.
6. If some chunks fail but ≥ 1 succeeded → continue and record failed files in `errorMessage`.
   If all fail → status `failed` with the most specific `ErrorCode`, no finalize.
7. `step.sendEvent('finalize', { name: 'review/finalize', data: { reviewId } })`.

### Function `review-finalize` — trigger event `review/finalize` `{ reviewId }` (also sent by ingest, lane D)
1. Load review, issues, PR, files. Exit if already `completed` (idempotent).
2. Drop issues whose file/line is not in the diff (`isLineInDiff`); sort by severity; cap at `maxIssuesPerPr`;
   filter by `minSeverity` for posting (keep all in DB).
3. `computeRisk(...)` from `@app/scoring` → save `riskScore`, `riskLevel`, `riskFactors`.
4. `postReview(...)` from `@app/github-comments` in its own `step.run` → save `githubReviewId`, mark issues `posted`.
5. Set `completed`, `finishedAt`.
`github_error` on post: retry (max 2), then `failed` / `github_error`.

### Function `review-sweep` — cron `*/5 * * * *`
- `waiting_action` older than 30 min → `failed` / `action_missing`
- `running` older than 20 min → `failed` / `timeout`

### Other
- Register all three in `functions` exported from `index.ts`.
- Log with `reviewId` (pino). Never log patches, AI text or tokens.

## Tests
Test function handlers by calling them with a fake `step` (or `@inngest/test` if available — VERIFY).
- Chunking: small PR → 1 chunk; 136-file PR fixture → several chunks; huge PR → too_large + prioritization
- Step outputs contain no patch text
- Partial failure → completed with note; total failure → failed with right code; `provider_auth` not retried
- Idempotency: running `review-start` twice / re-running a chunk step does not duplicate issues
- Sweep transitions

## Done when
- [ ] All tests pass with mocks, then again with real A/C/E packages once merged
- [ ] Locally: send `review/requested` for a seeded `queued` review from the Inngest dev UI → it runs to
      `completed` with the mock provider, one step per chunk visible in the run history

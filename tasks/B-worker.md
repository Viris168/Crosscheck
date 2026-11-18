# Task B — Review worker

**Branch:** `feat/b-worker` · **Phase 2** · **Depends on:** Foundation, A, C, E (mock any not yet merged)

## Goal
Run reviews in the background: split big PRs into chunks, call the chosen provider, store issues,
update progress, finalize (score + comments), and fail with a clear `ErrorCode`.

## You own
`apps/worker/` only.

## Do not touch
Any `packages/*`, `apps/api`, `apps/web`.

## Mocks until other lanes merge
- `@app/github` → `src/mocks/github.ts` returning fixture files
- `@app/providers` → `src/mocks/provider.ts` returning a fixed `ReviewChunkResult`
- `@app/scoring` / `@app/github-comments` → no-op mocks
Switch via import only; delete mocks once real packages are merged.

## Build

### Job `review.start` `{ reviewId }`
1. Load review + PR + repo. If status is not `queued`, exit (idempotent).
2. Set `running`, `startedAt`.
3. Fetch PR files (`fetchPullRequestFiles`). Drop: removed files, binary/no patch, `repo.settings.ignorePaths`,
   secret-like files (`.env*`, `*.pem`, `*.key`).
4. Load context: PR body, `CHANGE_NOTES.md` at head, `AGENTS.md` at head (via `fetchFileText`).
5. **Chunking:** estimate tokens (chars / 4). Pack files into chunks ≤ ~60k tokens each. A single file larger
   than the limit is truncated to its first hunks with a note. If total > 400k tokens, keep the
   highest-risk files first (paths matching auth, payment, migration, security, config) and set
   `errorCode: 'too_large'` as a *warning* on completion (review still completes).
6. Set `filesTotal`. Run chunks with concurrency 3 via `getProvider(repo.provider).reviewChunk(...)`.
   After each chunk: insert issues, increment `filesDone`.
7. Per-chunk retry: 2 retries with backoff for `timeout` / `rate_limited`; 1 retry for `invalid_output`;
   no retry for `provider_auth`.
8. If some chunks fail but ≥ 1 succeeded → finalize anyway and record failed files in `errorMessage`.
   If all fail → status `failed` with the most specific `ErrorCode`.
9. Enqueue `review.finalize`.

### Job `review.finalize` `{ reviewId }` (also enqueued by the ingest endpoint, lane D)
1. Load review, issues, PR, files.
2. Drop issues whose file/line is not in the diff; sort by severity; cap at `maxIssuesPerPr`;
   filter by `minSeverity` for posting (keep all in DB).
3. `computeRisk(...)` from `@app/scoring` → save `riskScore`, `riskLevel`, `riskFactors`.
4. `postReview(...)` from `@app/github-comments` → save `githubReviewId`, mark issues `posted`.
5. Set `completed`, `finishedAt`.

### Job `review.sweep` (repeatable, every 5 min)
- `waiting_action` older than 30 min → `failed` / `action_missing`
- `running` older than 20 min → `failed` / `timeout`

### Other
- Graceful shutdown on SIGTERM. Worker concurrency from env `WORKER_CONCURRENCY` (default 4).
- Log with `reviewId`. Never log patches or tokens.

## Tests
- Chunking: small PR → 1 chunk; 136-file PR fixture → several chunks; huge PR → too_large + prioritization
- Partial failure → completed with note; total failure → failed with right code
- Idempotency: running `review.start` twice does not duplicate issues
- Sweep transitions

## Done when
- [ ] All tests pass with mocks, then again with real A/C/E packages once merged
- [ ] A seeded `queued` review runs to `completed` locally with the mock provider

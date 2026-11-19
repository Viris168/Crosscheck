# Integration (Phase 3)

All lanes (Foundation, A–G) are merged. This file tracks wiring status, how to run the live end-to-end
check, and follow-ups found while wiring.

## Status (2026-11-19)
| Path | Verified locally (no GitHub App) | Live on a real repo |
|---|---|---|
| Webhook → `Review(queued)` → Inngest `review-start` | ✅ signed webhook → review row → event → function runs; stops at the first GitHub call (`GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set`) → `failed` | ⏳ needs the GitHub App |
| Action result → `/api/ingest/review` → `review-finalize` | ✅ 202, duplicate → 200, issues + `aiRiskScore` saved, finalize runs; stops at the GitHub call → `failed` | ⏳ needs the App + a public URL |
| Webhook security | ✅ bad signature → 401, repeated delivery id → `duplicate` | — |
| Ingest security | ✅ no token → 401 | — |
| Mocks / stubs | ✅ none left (`lib/stubs.ts` deleted; jobs use real `@app/scoring` / `@app/github-comments`) | — |

## Fixed while wiring
- **Inngest could not call the app in dev.** The dev server runs in Docker; the app registered itself as
  `http://localhost:3000`, which inside the container is the container itself (`connection refused`, review
  stuck in `queued`). Fix: `INNGEST_SERVE_HOST=http://host.docker.internal:3000` in `.env.example` (dev
  only; production compose syncs via `http://web:3000`).
- **Ingest picked a failed review** when one commit had several Action reviews (e.g. after "re-run with
  another provider") and none matched the repo's provider. It now prefers a `waiting_action` review.
- Lane stubs replaced with the real packages: `@app/workflow-templates` (setup PR), `chatgptOAuth` from
  `@app/providers`, and live PR files via `@app/github` (`lib/server/pull-files.ts`).

## Follow-ups (not wiring; left for a lane task)
1. **`queued` reviews never time out.** If Inngest can't run `review-start` (app unreachable, function
   deleted), the review stays `queued` forever. `review-sweep` handles only `running` (20 min) and
   `waiting_action` (30 min). Proposal (lane B): `queued` older than 30 min → `failed` / `internal`.
2. **Missing GitHub App config is reported as `internal`.** The UI then says "Something went wrong on our
   side". `github_error` (or a clear setup message) would point the user at the App settings.
3. `pnpm e2e` defaults to `--provider platform`, which calls the Anthropic API (**paid**). For the free
   demo use `--provider claude_action`.

## Running the live e2e script
`scripts/e2e.ts` drives a real PR through the pipeline and checks every hop (review row → GitHub review +
inline comments → dashboard API → Inngest runs), then cleans up (`--keep` to leave the PR open).

**One-time setup (you do this; secrets never go into chat or git):**
1. A **public** test repo on GitHub (Actions are free there).
2. A smee.io channel, and a GitHub App as in `docs/deploy.md` §1.2 (webhook URL = the smee channel).
   Install it on the test repo.
3. In `.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET`, and `INNGEST_SERVE_HOST=http://host.docker.internal:3000`.
4. For `claude_action` (free on a Claude plan): the dashboard's setup wizard commits
   `.github/workflows/ai-review.yml`; add repo secrets `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) and
   `PLATFORM_INGEST_TOKEN`; run `cloudflared tunnel --url http://localhost:3000` and set `PUBLIC_URL` /
   `BETTER_AUTH_URL` to the tunnel URL (the Action must reach `/api/ingest/review`).

**Run:**
```bash
docker compose -f docker-compose.dev.yml up -d && pnpm db:migrate
pnpm dev                                                    # terminal 1
npx smee-client -u https://smee.io/<channel> -t http://localhost:3000/api/webhooks/github   # terminal 2
pnpm e2e --repo <owner>/<test-repo> --provider claude_action   # terminal 3 (platform = paid API)
```
Dev databases only: the script creates a short-lived session (and an `e2e_` user if the org has none).

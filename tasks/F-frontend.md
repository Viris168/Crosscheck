# Task F — Frontend (dashboard, PR pages, settings, setup wizard)

**Branch:** `feat/f-frontend` · **Phase 1** · **Depends on:** Foundation. Uses D and C later (mock first).

## Goal
The product UI: sign in, see repos and PRs across the org, open a PR to see its review in one of five
states, configure the reviewer per repo, and follow a setup wizard.

## You own
- `apps/web/src/app/` — pages and the dashboard REST route handlers in `src/app/api/` **except**
  `api/webhooks/` (A), `api/ingest/` (D), `api/inngest/`, `api/auth/`, `api/health/` (Foundation)
- `apps/web/src/components/`, `apps/web/src/hooks/`, `apps/web/src/lib/` (except `lib/auth-client.ts`, Foundation)

## Do not touch
`apps/web/src/server/**` (A, B, D, Foundation), `packages/*`. You may add dependencies to
`apps/web/package.json`. To start a review from retry/rerun, import `inngest` from `@/server/jobs` and
send `review/requested` `{ reviewId, orgId }`.

## Mocks until other lanes merge
- Build the UI against the zod schemas in `@app/shared` (`api/pulls.ts`, `api/reviews.ts`, ...), served by
  your own REST route handlers reading Prisma. Use the Foundation seed data (one review per status).
- `@app/workflow-templates` and `chatgptOAuth` (from `@app/providers`): stub in `src/lib/stubs.ts`.

## Build

### Auth
Better Auth is configured by Foundation (`@/server/auth`, client `@/lib/auth-client`): GitHub login +
organization plugin. You build the sign-in page, sign-out, org switcher (active organization), and a
route guard for signed-out users. Every dashboard route calls `requireSession` and `requireOrgMember`
for the requested org/repo.

### REST + data fetching (see `docs/tech-stack.md` → "Rules for the API")
- Every route handler: parse params/query/body with the request schema from `@app/shared` (400 on failure),
  return data matching the response schema, errors as `{ error: { code, message } }`.
- One typed client `src/lib/api-client.ts` (`apiFetch(path, schema, init)` + `ApiError`).
- TanStack Query hooks in `src/hooks/`, one file per area: `useRepos`, `usePulls(repoId, state)`,
  `usePull(repoId, number)`, `useReview(id)` (polls every 3s while `queued`/`running`/`waiting_action`),
  `useRetryReview`, `useRerunReview`, `useRepoSettings`, `useRotateIngestToken`, `useOverview(orgId, range)`.
- Never hand-write response types: use `z.infer` from `@app/shared`.
- Endpoints: all "Dashboard" rows in `docs/tech-stack.md`.

### Pages
| Route | Content |
|---|---|
| `/` | Org overview: repos, open PRs by risk level, risk-over-time chart (last 30/90 days), most common issue categories |
| `/repos` | Repo list with provider badge, last review status, "Set up" if not configured |
| `/repos/[repoId]/pulls?state=open\|closed\|all` | PR list. Tabs change the query param only (one page). Show risk badge, +/− lines, files, latest review status, stale label |
| `/repos/[repoId]/pulls/[number]` | Header (title, branch → base, +/−, files, GitHub link). Tabs: **Reviews**, **Changed Files** |
| `/repos/[repoId]/settings` | Provider picker, model, minSeverity, ignorePaths, maxIssuesPerPr, language, trigger; ingest token show-once + rotate; danger zone |
| `/repos/[repoId]/setup` | Wizard, branches by provider (below) |
| `/settings/connections` | Sign in with ChatGPT connect / disconnect |

### Reviews tab — one component per state
| State | Shows | Actions |
|---|---|---|
| `queued` | "Waiting to start", provider | Cancel |
| `running` | "Reviewed X of Y files", progress bar, elapsed time (poll every 3s) | — |
| `waiting_action` | "Waiting for your GitHub Action" + checklist (workflow file, 2 secrets) + link to Actions tab | Open setup |
| `completed` | Risk score + level + factors, summary, issues grouped by file → click jumps to Changed Files at that line. "Stale" banner if PR head ≠ review sha | Re-run, Re-run with other provider |
| `failed` | Message per `errorCode` (table below) | Retry, Change provider |

| errorCode | Message |
|---|---|
| too_large | "This PR is very large (N files). We reviewed the riskiest files first." |
| provider_auth | Claude: "Your Claude token expired — run `claude setup-token` and update the `CLAUDE_CODE_OAUTH_TOKEN` secret." ChatGPT: "Reconnect ChatGPT." |
| rate_limited | "Your plan's usage limit was reached. Retry later or switch provider." |
| timeout | "The review took too long." |
| action_missing | "Your GitHub Action didn't send a result." + link to workflow runs |
| invalid_output | "The AI returned an invalid result." |
| github_error / internal | "Something went wrong on our side." + review id |

### Changed Files tab
File tree + unified diff viewer; inline issue markers on lines that have findings.

### Setup wizard
1. Install GitHub App (link) → 2. Choose AI: Claude (my plan) / Codex (my ChatGPT plan) / Codex (my OpenAI key) / Platform default →
3. Provider-specific steps:
   - Claude Action: explain `claude setup-token`, show ingest token once, list secrets
     `CLAUDE_CODE_OAUTH_TOKEN` + `PLATFORM_INGEST_TOKEN`, button "Commit workflow" (calls `openWorkflowPR`)
   - Codex Action: same with `OPENAI_API_KEY`
   - Codex ChatGPT: "Sign in with ChatGPT" button (route handlers `src/app/api/oauth/chatgpt/start|callback`
     using `chatgptOAuth`, store `encrypt()`ed token in `ProviderCredential`; validate `state`)
   - Platform: nothing to do
4. "Test connection": re-run review on the latest open PR and watch the state.
Never show an input field for a Claude token or OpenAI key — they go into GitHub Secrets only.

### Design
Tailwind + shadcn/ui. Clean, light, matches the existing screenshots (rounded cards, green/red +/− pills, status chips).
Accessible: keyboard navigation, visible focus, color is never the only signal.

## Tests
- Component tests for each review state and each error message
- API route tests: session required (401), membership checks (user cannot read another org's repo → 403/404),
  invalid query → 400, PR list filter by state, responses parse with the shared response schema
- Playwright smoke: login (mocked) → repo → PR → completed review renders

## Done when
- [ ] All tests pass
- [ ] With seed data, every review state and every page renders
- [ ] Stubs replaced by real `@app/workflow-templates` and `chatgptOAuth` once merged

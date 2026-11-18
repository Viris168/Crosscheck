# Task A — GitHub integration

**Branch:** `feat/a-github` · **Phase 1** · **Depends on:** Foundation

## Goal
Connect to GitHub as a GitHub App: authenticate, receive webhooks, keep repos/PRs in sync, create
review rows, and send Inngest events. Provide a reusable GitHub client for other lanes.

## You own
- `packages/github/` → published as `@app/github`
- `apps/web/src/server/github/` (webhook logic; public entry `index.ts`)
- `apps/web/src/app/api/webhooks/github/route.ts` (replace the 501 stub)

## Do not touch
`packages/shared`, `packages/db`, `apps/web/src/server/jobs/`, `apps/web/src/server/ingest/`, any other
`apps/web/src/app/` route, anything else. You may add dependencies to `apps/web/package.json`.

## Mocks until other lanes merge
- Inngest sending: import `inngest` from `@/server/jobs` (Foundation created the client) and call
  `inngest.send({ name: 'review/requested', data: { reviewId, orgId } })`. In tests, mock `inngest.send`.

## Build

### `@app/github` (public API — other lanes depend on this exact surface)
```ts
export function getInstallationOctokit(installationId: number): Promise<Octokit>;  // cached until token expiry
export function getAppOctokit(): Octokit;
export async function fetchPullRequest(octokit, owner, repo, number): Promise<PrMeta>;
export async function fetchPullRequestFiles(octokit, owner, repo, number): Promise<ReviewFile[]>; // paginates (max 3000 files)
export async function fetchFileText(octokit, owner, repo, path, ref): Promise<string | null>;     // for AGENTS.md, CHANGE_NOTES.md
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean;
export function splitFullName(fullName: string): { owner: string; repo: string };
```
Use `@octokit/app` / `@octokit/rest` with retry + throttling plugins. Map GitHub API failures to
`ProviderError('github_error', …)`.

### Webhook route (`apps/web/src/app/api/webhooks/github/route.ts` → `@/server/github`)
- `export const runtime = 'nodejs'`. Read the raw body with `await req.text()` (before any JSON parse),
  verify `X-Hub-Signature-256` → 401 if invalid. Respond within 1s: only DB upserts + `inngest.send` here;
  heavy work happens in Inngest functions (lane B).
- Dedupe by `X-GitHub-Delivery` (Redis `SET NX` with 24h TTL, client from `@/server/redis`).
- Keep the route file thin: `export async function POST(req) { return handleGithubWebhook(req) }`.
- Handle events:
  - `installation` / `installation_repositories`: upsert `Installation` and `Repo` rows (new repos get
    `provider: 'platform'`, default settings). Mark removed repos `active: false`. Link the installation to
    the Better Auth `Organization` whose `githubAccountLogin` matches the account (create the org if
    missing; the installing user — matched via `Account.accountId` — becomes `owner`).
  - `pull_request` `opened | reopened | synchronize | ready_for_review`: upsert `PullRequest`; skip drafts;
    if `repo.settings.trigger === 'every_push'`, create a `Review` for the new `headSha`:
    - provider `runsInWorker` (platform, codex_chatgpt) → status `queued`, send event `review/requested`
    - action providers → status `waiting_action` (no event; the Action posts results to ingest)
  - `pull_request` `closed`: update state to `closed` or `merged`.
  - `issue_comment` `created` with body starting `/review` on a PR: create a Review as above (on-command trigger).
- Never create two reviews for the same `[pullRequestId, headSha, provider]`.
- Event names/payloads come from `events` in `@app/shared` — never put code or tokens in event data.

## Tests
- Signature verify: valid, invalid, missing header, timing-safe
- Each event handler with fixture payloads (store fixtures in `apps/web/src/server/github/__fixtures__/`)
- Dedupe of repeated deliveries; draft PR skipped; action provider → `waiting_action`, no event sent;
  `runsInWorker` provider → exactly one `review/requested` sent
- `fetchPullRequestFiles` pagination (mock HTTP)

## Done when
- [ ] All tests pass
- [ ] Local test with smee.io: open a PR on a test repo → `Review` row created + `review/requested`
      visible in the Inngest dev UI (:8288)
- [ ] README in `packages/github` documenting the public API

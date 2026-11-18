# Task A — GitHub integration

**Branch:** `feat/a-github` · **Phase 1** · **Depends on:** Foundation

## Goal
Connect to GitHub as a GitHub App: authenticate, receive webhooks, keep repos/PRs in sync, create
review rows, and queue work. Provide a reusable GitHub client for other lanes.

## You own
- `packages/github/` → published as `@app/github`
- `apps/api/src/github/` (replace the 501 stub `plugin.ts`)

## Do not touch
`packages/shared`, `packages/db`, `apps/api/src/server.ts`, `apps/api/src/ingest/`, anything else.

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

### Webhook plugin (`apps/api/src/github/plugin.ts`)
- Read the raw body, verify `X-Hub-Signature-256` → 401 if invalid. Respond within 1s; do heavy work async.
- Dedupe by `X-GitHub-Delivery` (Redis SET with 24h TTL).
- Handle events:
  - `installation` / `installation_repositories`: upsert `Installation` and `Repo` rows (new repos get
    `provider: 'platform'`, default settings). Mark removed repos `active: false`.
  - `pull_request` `opened | reopened | synchronize | ready_for_review`: upsert `PullRequest`; skip drafts;
    if `repo.settings.trigger === 'every_push'`, create a `Review` for the new `headSha`:
    - provider `runsInWorker` (platform, codex_chatgpt) → status `queued`, enqueue `review.start`
    - action providers → status `waiting_action` (no job; the Action posts results to ingest)
  - `pull_request` `closed`: update state to `closed` or `merged`.
  - `issue_comment` `created` with body starting `/review` on a PR: create a Review as above (on-command trigger).
- Never create two reviews for the same `[pullRequestId, headSha, provider]`.
- Use BullMQ `Queue(QUEUE)` from `@app/shared` constants.

## Tests
- Signature verify: valid, invalid, missing header, timing-safe
- Each event handler with fixture payloads (store fixtures in `apps/api/src/github/__fixtures__/`)
- Dedupe of repeated deliveries; draft PR skipped; action provider → `waiting_action`, no job
- `fetchPullRequestFiles` pagination (mock HTTP)

## Done when
- [ ] All tests pass
- [ ] Local test with smee.io: open a PR on a test repo → `Review` row created + job enqueued
- [ ] README in `packages/github` documenting the public API

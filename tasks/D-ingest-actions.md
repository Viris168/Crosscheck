# Task D — Ingest endpoint + GitHub Action templates

**Branch:** `feat/d-ingest` · **Phase 2** · **Depends on:** Foundation, A (`@app/github`), C (`buildActionPrompt`)

## Goal
Let users run Claude Code or Codex in their own GitHub Actions (on their own plan / key) and send the
result to the platform. The platform never sees their Claude token or OpenAI key.

## You own
- `apps/web/src/server/ingest/` (ingest logic; public entry `index.ts`)
- `apps/web/src/app/api/ingest/` (replace the 501 stub `review/route.ts`)
- `packages/workflow-templates/` → `@app/workflow-templates`

## Do not touch
Anything else (including `apps/web/src/server/jobs/` and `packages/shared`). You may add dependencies to
`apps/web/package.json`.

## Mocks until other lanes merge
- Inngest sending: import `inngest` from `@/server/jobs` (Foundation created the client); mock `inngest.send`
  in tests.
- `buildActionPrompt` (lane C): local stub in `packages/workflow-templates/src/prompt-stub.ts` until merged.

## Build

### `POST /api/ingest/review` (`apps/web/src/app/api/ingest/review/route.ts` → `@/server/ingest`)
- `export const runtime = 'nodejs'`. Keep the route file thin; logic lives in `src/server/ingest/`.
- Auth: `Authorization: Bearer rit_…` → `hashToken()` → find `Repo` by `ingestTokenHash` (constant-time
  compare). 401 if not found or repo inactive.
- Body limit 1 MB: reject on `Content-Length` > 1 MB **and** stop reading the stream past 1 MB → 413
  (Next.js route handlers have no built-in body limit; Caddy also caps at 2 MB). Parse with
  `IngestRequest` from `@app/shared` (`ReviewResultSchema` or the `no_output` shape). Special case `{ "error": "no_output" }` →
  mark review `failed` / `invalid_output`.
- Check `body.repo === repo.fullName`. Check the PR exists and is open, and `head_sha` matches a `Review` in
  `waiting_action` for that PR (or create one if the PR's current head matches). Otherwise 409.
- Idempotent per `[pullRequestId, headSha, provider]`: second submit → 200 with `{ duplicate: true }`.
- Save issues, `filesTotal = filesDone = changedFiles`, then
  `inngest.send({ name: 'review/finalize', data: { reviewId } })`. Return 202.
- Rate limit: 30 requests / hour per token (Redis, client from `@/server/redis`) → 429.
- Errors use `{ error: { code, message } }`.

### `@app/workflow-templates`
```ts
export function renderWorkflow(provider: 'claude_action' | 'codex_action', opts: {
  publicUrl: string; model?: string; maxTurns?: number;
}): string;   // YAML text
export async function openWorkflowPR(octokit, fullName: string, provider, yaml: string): Promise<{ prUrl: string }>;
export function removeWorkflowPR(octokit, fullName: string): Promise<{ prUrl: string }>;
export const WORKFLOW_PATH = '.github/workflows/ai-review.yml';
```
Templates:
- **Claude:** `anthropics/claude-code-action@v1` with `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`
- **Codex:** `openai/codex-action@v1` with `${{ secrets.OPENAI_API_KEY }}`
- Both: trigger on `pull_request` `[opened, synchronize, reopened]`; checkout with `fetch-depth: 0`;
  prompt from `buildActionPrompt()` with repo/PR/sha interpolated; agent writes `review.json` only and
  does not post comments; final step (`if: always()`) POSTs `review.json` (or `{"error":"no_output"}`) to
  `${publicUrl}/api/ingest/review` with `secrets.PLATFORM_INGEST_TOKEN`; `concurrency` group per PR with
  cancel-in-progress.
- **Check both actions' current READMEs for exact input names; mark assumptions with `# VERIFY:`.**
- `openWorkflowPR`: create branch `ai-review/setup`, commit file, open PR titled
  "Add AI review workflow" with a body listing the secrets the user must add.

## Tests
- Ingest: valid → 202 + `review/finalize` sent; bad token → 401; wrong repo → 409; stale sha → 409;
  duplicate → 200; oversize → 413; schema-invalid → 400; rate limit → 429; `no_output` → review failed
- Template snapshot tests for both providers; YAML parses (`yaml` package)

## Done when
- [ ] All tests pass
- [ ] Manual: real test repo with the generated Claude workflow → PR → result reaches ingest → review row
      goes `waiting_action` → `review/finalize` visible in the Inngest dev UI

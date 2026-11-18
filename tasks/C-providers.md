# Task C — AI providers

**Branch:** `feat/c-providers` · **Phase 1** · **Depends on:** Foundation

## Goal
One package that turns a `ReviewChunkInput` into a validated `ReviewChunkResult`, for every provider,
plus the shared review prompt and the Sign in with ChatGPT OAuth helpers.

## You own
`packages/providers/` → `@app/providers`

## Do not touch
Anything outside `packages/providers/`.

## Build

### Public API
```ts
export function getProvider(id: ProviderId): ReviewProvider;
export function buildReviewPrompt(input: ReviewChunkInput): { system: string; user: string };
export function buildActionPrompt(opts: { schemaVersion: 1 }): string;   // text D puts into workflow YAML
export function parseModelOutput(text: string): ReviewChunkResult;       // extract JSON, zod-validate
export const chatgptOAuth: {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: Date }>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: Date }>;
};
```

### Providers
| id | runsInWorker | Implementation |
|---|---|---|
| `platform` | true | Anthropic Messages API with `ANTHROPIC_API_KEY` (fallback: OpenAI with `OPENAI_API_KEY`). Model from repo settings or env default. |
| `codex_chatgpt` | true | Load `ProviderCredential` for `ctx.orgId` (+ `ctx.userId`), `decrypt()`, refresh if expired (save back encrypted), call OpenAI with the user's token using the plan-usage scope. **Check OpenAI's current "Sign in with ChatGPT" developer docs for exact endpoints, scopes and request format before coding — mark any assumption with `// VERIFY:`.** |
| `claude_action` | false | `reviewChunk` throws — reviews arrive via ingest. |
| `codex_action` | false | Same as above. |
| `mock` (test only) | true | Deterministic fixture output. |

### Prompt (`buildReviewPrompt`)
- System: senior reviewer; review ONLY the given diff; check the change matches the stated intent
  (PR title/body, `intentNotes`); follow `guidelines`; report bugs, security, performance, missing tests;
  no style nitpicks unless guidelines ask; return ONLY JSON matching the schema (include the schema text).
- User: PR title, body, intent notes, guidelines, then each file as `### path (status)` + fenced patch with
  new-file line numbers annotated so the model can cite correct `line` values.
- Tell the model it is chunk `i of n` and should judge risk for this chunk only.

### Error mapping
HTTP 401/403 → `provider_auth`; 429 / quota → `rate_limited`; timeouts (90s per call) → `timeout`;
unparseable or schema-invalid JSON → `invalid_output`. Always throw `ProviderError`.

## Tests
- Prompt snapshot tests
- `parseModelOutput`: clean JSON, JSON inside ```json fences, trailing text, invalid → `invalid_output`
- Error mapping per status code (mock HTTP)
- `codex_chatgpt`: expired token triggers refresh and re-save (mock DB + HTTP)

## Done when
- [ ] All tests pass
- [ ] A script `pnpm --filter @app/providers try:platform` reviews a sample diff with a real API key and
      prints valid JSON
- [ ] README lists every `// VERIFY:` assumption

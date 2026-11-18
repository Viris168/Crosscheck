# @app/providers

Turns a `ReviewChunkInput` into a validated `ReviewChunkResult` for every provider. Also holds the shared
review prompt, the GitHub Action prompt, and the Sign in with ChatGPT OAuth helpers.
It has no Next.js or Inngest dependency. Call it from inside an Inngest `step.run`.

## Public API

```ts
getProvider(id: ProviderId): ReviewProvider        // cached per id
getProvider('mock'): MockProvider                  // tests only; deterministic fixture output
buildReviewPrompt(input): { system, user }
buildActionPrompt({ schemaVersion: 1 }): string    // placeholders: ACTION_PROMPT_PLACEHOLDERS; output file: ACTION_OUTPUT_FILE
parseModelOutput(text): ReviewChunkResult          // throws ProviderError('invalid_output')
chatgptOAuth.authorizeUrl(state, redirectUri, { codeChallenge?, nonce? })
chatgptOAuth.exchangeCode(code, redirectUri, { codeVerifier? })
chatgptOAuth.refresh(refreshToken)
createPkcePair(): { verifier, challenge }
```

Factories with injectable deps (`fetch`, `env`, credential store, clock) for tests:
`createPlatformProvider`, `createCodexChatgptProvider`, `createChatgptOAuth`, `createActionProvider`.

| id | runsInWorker | What it does |
|---|---|---|
| `platform` | yes | Anthropic Messages API (`ANTHROPIC_API_KEY`). If that key is not set, it uses the OpenAI Responses API (`OPENAI_API_KEY`). The model comes from `repo.settings.model`, then `PLATFORM_MODEL` / `OPENAI_MODEL`, then the defaults. |
| `codex_chatgpt` | yes | Loads the org's `ProviderCredential`, decrypts it, refreshes it if it is expired or expires within 2 minutes (saves it back encrypted), then calls the OpenAI Responses API with the user's token. |
| `claude_action`, `codex_action` | no | `reviewChunk` throws. These results arrive via ingest. |
| `mock` | yes | Returns deterministic fixture output. |

### Error mapping (always `ProviderError`)
| Cause | `code` |
|---|---|
| HTTP 401 / 403, OAuth `invalid_grant`, missing or undecryptable credential, no API key | `provider_auth` |
| HTTP 429, 529 (Anthropic overloaded), OpenAI `insufficient_quota` | `rate_limited` |
| 90 s per-call timeout (`LIMITS.providerCallTimeoutMs`), HTTP 408 / 504 | `timeout` |
| Empty, unparseable or schema-invalid output; model refusal | `invalid_output` |
| Anything else | `internal` |

The SDK clients run with `maxRetries: 0`. Retries are handled by lane B's Inngest steps.

### Prompt notes
- Diff lines are annotated with new-file line numbers (`  12 | +code`). Removed lines get no number.
- Fences are longer than any run of backticks in the patch, so a patch can't close its fence early.
- The prompt marks PR text, guidelines and diff as untrusted and tells the model not to follow instructions inside them.
- The JSON Schema in the prompt is generated from `ReviewResultSchema` in `@app/shared` (via `z.toJSONSchema`).

## Env vars read
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ENCRYPTION_KEY`, `CHATGPT_OAUTH_CLIENT_ID`, `CHATGPT_OAUTH_CLIENT_SECRET`,
plus these optional ones that `.env.example` does not list yet (see `tasks/CONTRACT_REQUESTS.md`):
`PLATFORM_MODEL` (default `claude-opus-5-5`), `PLATFORM_EFFORT` (default `medium`), `OPENAI_MODEL`
(default `gpt-5`), `CHATGPT_MODEL` (default `gpt-5-codex`).

## Manual smoke test
```bash
pnpm --filter @app/providers try:platform   # needs ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the root .env
```

## `// VERIFY:` assumptions
1. **ChatGPT OAuth endpoints, scopes and `resource`** (`src/chatgpt-oauth.ts`): `https://auth.openai.com/api/accounts/authorize`,
   `.../oauth/token`, scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
   and `resource=https://api.openai.com/v1`, taken from OpenAI's SIWC token-sharing guide (checked 2026-11-18).
   That guide covers the open-source loopback/public-client flow. A hosted web app may need a different
   registration, so confirm with OpenAI.
2. **`client_secret` on the token request**: the guide says a public client needs no secret. We send it only when
   `CHATGPT_OAUTH_CLIENT_SECRET` is set.
3. **Refresh request**: the standard RFC 6749 `refresh_token` grant (with `resource`). The guide says refresh tokens
   rotate but doesn't document the request. We save the new refresh token when one is returned.
4. **Plan-usage inference** (`src/providers/codex-chatgpt.ts`): the user's access token is sent as a Bearer token to
   `https://api.openai.com/v1/responses`. Default model is `gpt-5-codex`.
5. **OpenAI platform fallback model** (`src/providers/platform.ts`): default `gpt-5`.

Not marked `VERIFY` because it was checked against the installed `@anthropic-ai/sdk` 1.8 types: the Anthropic call uses
`client.beta.messages.create` with `output_config.effort` and the server-side refusal fallback
(`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`). A refusal that still happens maps to `invalid_output`.

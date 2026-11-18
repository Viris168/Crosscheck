# Essential Architecture (read this first)

One page. Everything an agent must know before touching code. Details: `docs/architecture.md`.

## What it does
GitHub PR → AI review (user's chosen provider) → one `ReviewResult` JSON → risk score → inline GitHub
comments + dashboard.

## The pieces
```
apps/web      Next.js UI + dashboard API + ChatGPT OAuth routes
apps/api      Fastify: /api/webhooks/github, /api/ingest/review, /health
apps/worker   BullMQ jobs: review.start, review.finalize, review.sweep
packages/shared             contracts (source of truth)
packages/db                 Prisma schema
packages/github             GitHub App auth + fetch
packages/providers          prompts + LLM calls + ChatGPT OAuth
packages/scoring            risk formula
packages/github-comments    post reviews to GitHub
packages/workflow-templates Claude/Codex Action YAML
infra/                      Docker, Caddy, scripts
```

## Two paths, one result
```
Worker path (platform, codex_chatgpt):
  webhook → Review(queued) → review.start → chunk → provider → issues → review.finalize

Action path (claude_action, codex_action):
  webhook → Review(waiting_action) → user's Action → POST /api/ingest/review → review.finalize

review.finalize (shared): drop out-of-diff issues → computeRisk → post GitHub review → completed
```

## Review states
`queued → running → completed | failed` · `waiting_action → completed | failed`
`stale` = review.headSha ≠ PR.headSha (derived, not stored).
Failures always carry an `ErrorCode`: `too_large, provider_auth, rate_limited, timeout,
action_missing, invalid_output, github_error, internal`.

## Invariants — never break these
1. **Contracts live in `packages/shared`.** Every provider returns `ReviewResult` schema v1. Don't invent
   parallel types.
2. **Never receive or store a user's Claude token or Action OpenAI key.** They stay in GitHub Secrets.
3. **ChatGPT tokens: `encrypt()` at rest. Ingest tokens: `hashToken()` only.**
4. **Never store source code, patches, prompts or raw AI output.** Store findings + metadata.
5. **Never send secret-like files to AI** (`.env*`, `*.pem`, `*.key`, lockfiles, `ignorePaths`).
6. **AI output and ingest payloads are untrusted:** zod-validate, cap lengths, escape markdown, drop
   issues not in the diff, neutralize @mentions.
7. **Webhooks:** verify HMAC, dedupe delivery id, respond < 1s, do work in jobs.
8. **Jobs are idempotent.** One review per `[pullRequestId, headSha, provider]`.
9. **Only our GitHub App posts comments** (via `@app/github-comments`), for every provider.
10. **Every dashboard query is scoped to the user's org membership.**

## Limits
Chunk ~60k tokens · total ~400k (riskiest first) · 3 concurrent chunk calls · 90s per call ·
20 min review timeout · 30 min Action timeout · 50 inline comments · 1 MB ingest.

## Stack
TypeScript strict · pnpm + Turborepo · Next.js · Fastify · BullMQ/Redis · Prisma/Postgres ·
Vitest · Docker Compose + Caddy on one VPS.

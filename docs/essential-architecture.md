# Essential Architecture (read this first)

One page. Everything an agent must know before touching code. Details: `docs/architecture.md`.
Stack decisions: `docs/tech-stack.md` (wins over this file if they disagree).

## What it does
GitHub PR → AI review (user's chosen provider) → one `ReviewResult` JSON → risk score → inline GitHub
comments + dashboard.

## The pieces
```
apps/web                      ONE Next.js app (UI + REST API + Inngest endpoint)
  src/app/                    pages + dashboard REST routes (/api/repos, /api/reviews, ...)
  src/app/api/webhooks/github POST webhook route        → src/server/github/
  src/app/api/ingest/review   POST Action results route → src/server/ingest/
  src/app/api/inngest         Inngest serve() endpoint  → src/server/jobs/
  src/server/jobs/            Inngest functions: review-start, review-finalize, review-sweep
  src/server/auth.ts          Better Auth (GitHub login + organization plugin)
packages/shared             contracts (source of truth): zod API schemas, events, enums, crypto
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
Job path (platform, codex_chatgpt):
  webhook → Review(queued) → event review/requested → review-start
          → chunk → one step.run per chunk (provider + save issues) → event review/finalize

Action path (claude_action, codex_action):
  webhook → Review(waiting_action) → user's Action → POST /api/ingest/review → event review/finalize

review-finalize (shared): drop out-of-diff issues → computeRisk → post GitHub review → completed
```

## Review states
`queued → running → completed | failed` · `waiting_action → completed | failed`
`stale` = review.headSha ≠ PR.headSha (derived, not stored).
Failures always carry an `ErrorCode`: `too_large, provider_auth, rate_limited, timeout,
action_missing, invalid_output, github_error, internal`.

## Invariants — never break these
1. **Contracts live in `packages/shared`.** Every provider returns `ReviewResult` schema v1; every REST
   endpoint and Inngest event has a zod schema there. Don't invent parallel types.
2. **Never receive or store a user's Claude token or Action OpenAI key.** They stay in GitHub Secrets.
3. **ChatGPT tokens: `encrypt()` at rest. Ingest tokens: `hashToken()` only.**
4. **Never store source code, patches, prompts or raw AI output.** Store findings + metadata.
   Inngest events and step outputs carry ids/counts only (step outputs are persisted by Inngest).
5. **Never send secret-like files to AI** (`.env*`, `*.pem`, `*.key`, lockfiles, `ignorePaths`).
6. **AI output and ingest payloads are untrusted:** zod-validate, cap lengths, escape markdown, drop
   issues not in the diff, neutralize @mentions.
7. **Webhooks:** verify HMAC, dedupe delivery id, respond < 1s, do work in Inngest functions.
8. **Jobs are idempotent.** One review per `[pullRequestId, headSha, provider]`.
9. **Only our GitHub App posts comments** (via `@app/github-comments`), for every provider.
10. **Every dashboard route checks the Better Auth session and org membership.**

## Limits
Chunk ~60k tokens · total ~400k (riskiest first) · 3 concurrent chunk calls · 90s per call ·
20 min review timeout · 30 min Action timeout · 50 inline comments · 1 MB ingest ·
Inngest concurrency 3 reviews per org.

## Stack
TypeScript strict · pnpm + Turborepo · Next.js (App Router) + React · REST + zod · TanStack Query ·
Better Auth · Inngest (self-hosted) · Prisma/Postgres 16 · Redis 7 · Tailwind + shadcn/ui ·
Vitest + Playwright · Docker Compose + Caddy on one VPS.

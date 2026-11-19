# Tech Stack — AI Code Review Platform

**Status:** Decided · 2026-11-18
**Applies to:** every agent and every task in this repo. If another doc disagrees with this file, this file wins.

---

## Decision
Use **Next.js + React for both frontend and backend**, with a **REST-only API** whose request and response
shapes are **zod schemas shared** between client and server.

## The stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | Everywhere. No plain JS files. |
| Monorepo | pnpm workspaces + Turborepo | |
| App framework | **Next.js (App Router) + React** | ONE app: `apps/web`. UI + API route handlers + Inngest endpoint. |
| API | **REST** route handlers (`app/api/**/route.ts`) | No tRPC. No separate API server. |
| Contracts | **zod** schemas in `packages/shared` | Single source of truth for every request/response. |
| Data fetching | **TanStack Query** | Typed `fetch` client + query/mutation hooks. Polling for live review states. |
| ORM | **Prisma** | `packages/db` |
| Database | **PostgreSQL 16** | App DB + a separate DB for Inngest. |
| Auth | **Better Auth** | GitHub social login + **organization plugin** (orgs, members, roles). |
| Background jobs | **Inngest** (self-hosted) | Review pipeline as durable functions; needs Postgres + Redis. |
| Cache/queue store | **Redis 7** | Used by Inngest; also webhook delivery dedupe + rate limits. |
| UI | Tailwind CSS + shadcn/ui | |
| Tests | Vitest (unit/integration), Playwright (e2e smoke) | |
| Containers | **Docker & Docker Compose** | Same compose services locally and in production. |
| Hosting | **Now: local demo ($0).** Later: **Ubuntu VPS + Caddy** | Demo runs on a laptop (dev compose + smee.io webhooks, optional Cloudflare quick tunnel). VPS design is kept and documented: Caddy = automatic Let's Encrypt HTTPS, ~2 vCPU / 4 GB RAM (Oracle Cloud Always Free fits). |

## What we are NOT using (and why)
| Not using | Reason |
|---|---|
| Nest.js | Second app + CORS + cross-domain auth + boilerplate; backend is small (webhooks, DB, jobs, API calls). |
| Separate Fastify/Express API | Next.js route handlers cover webhooks, ingest and dashboard API. |
| tRPC | One API style only; REST is ready for a future public API (CLI, CI, customers). zod keeps type safety. |
| Vue | Stack is React-first (Next.js, TanStack Query, shadcn/ui, Better Auth examples); agents write React best. |
| BullMQ | Replaced by Inngest (step-level retries, concurrency per user, run history UI). |
| Auth.js | Replaced by Better Auth (built-in organizations + roles for multi-tenant). |

## Rules for the API (REST + zod)
1. Every endpoint has a request schema and a response schema in `packages/shared/src/api/<area>.ts`.
2. Route handlers parse input with the schema (`schema.parse` → 400 on failure) and return data typed by the
   response schema.
3. The client never hand-writes types: it uses `z.infer<typeof Schema>` from `@app/shared`.
4. One typed client in `apps/web/src/lib/api-client.ts`:
   ```ts
   export async function apiFetch<T extends z.ZodTypeAny>(
     path: string, schema: T, init?: RequestInit
   ): Promise<z.infer<T>> {
     const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
     if (!res.ok) throw await ApiError.from(res);
     return schema.parse(await res.json());
   }
   ```
5. TanStack Query hooks live in `apps/web/src/hooks/` (e.g. `usePulls(repoId, state)`, `useReview(id)`,
   `useRerunReview()`), one file per area.
6. Errors: JSON `{ error: { code, message } }` with proper status codes (400, 401, 403, 404, 409, 413, 429, 500).
7. Every dashboard endpoint checks the Better Auth session **and** org membership for the requested resource.

## Endpoints
**Public (called by GitHub / users' Actions — not by the browser):**
| Method | Path | Auth |
|---|---|---|
| POST | `/api/webhooks/github` | HMAC `X-Hub-Signature-256` |
| POST | `/api/ingest/review` | `Bearer rit_…` ingest token (stored hashed) |
| GET | `/api/health` | none |
| GET/POST/PUT | `/api/inngest` | Inngest signing key (Inngest SDK `serve()`) |

**Dashboard (session + org membership):**
| Method | Path |
|---|---|
| GET | `/api/repos` |
| GET | `/api/repos/:repoId/pulls?state=open\|closed\|all` |
| GET | `/api/repos/:repoId/pulls/:number` |
| GET | `/api/reviews/:id` |
| POST | `/api/reviews/:id/retry` |
| POST | `/api/reviews/:id/cancel` (only `queued` / `waiting_action`) |
| POST | `/api/repos/:repoId/pulls/:number/rerun` (body: `{ provider? }`) |
| GET/PUT | `/api/repos/:repoId/settings` |
| POST | `/api/repos/:repoId/ingest-token/rotate` |
| POST | `/api/repos/:repoId/setup/workflow-pr` |
| GET | `/api/orgs/:orgId/overview?range=30d\|90d` |
| GET | `/api/oauth/chatgpt/start`, `/api/oauth/chatgpt/callback` |
| GET/DELETE | `/api/connections/chatgpt` |
| * | `/api/auth/*` (Better Auth handler) |

## Background jobs (Inngest)
| Function | Trigger event | Does |
|---|---|---|
| `review-start` | `review/requested` `{ reviewId, orgId }` | Fetch diff + context, chunk; **one `step.run` per chunk** (provider call + save issues); then send `review/finalize` |
| `review-finalize` | `review/finalize` `{ reviewId }` | Drop out-of-diff issues, compute risk, post GitHub review, mark completed |
| `review-sweep` | cron every 5 min | `waiting_action` > 30 min → failed `action_missing`; `running` > 20 min → failed `timeout` |

Settings: concurrency limit keyed by `orgId` (e.g. 3); retries per step (timeout/rate_limited 2, invalid_output 1,
provider_auth 0 → use `NonRetriableError`); event payloads carry ids only, never code or tokens.
Event names and payload schemas live in `packages/shared/src/events.ts`.

## Folder structure
```
apps/
  web/                         Next.js app (UI + API + Inngest endpoint)
    src/app/                   pages (App Router)
    src/app/api/               REST route handlers
    src/server/github/         webhook handling            (lane A)
    src/server/ingest/         Action result ingest        (lane D)
    src/server/jobs/           Inngest client + functions  (lane B)
    src/server/auth.ts         Better Auth config
    src/lib/api-client.ts      typed fetch
    src/hooks/                 TanStack Query hooks
    src/components/
packages/
  shared/                      zod contracts: api/, events.ts, review-result.ts, enums, crypto
  db/                          Prisma schema + client
  github/                      GitHub App auth + fetch helpers
  providers/                   AI providers + prompts + ChatGPT OAuth helpers
  scoring/                     risk formula
  github-comments/             post reviews to GitHub
  workflow-templates/          Claude/Codex Action YAML
infra/
  docker/web.Dockerfile
  compose.prod.yml             caddy, web, inngest, postgres, redis, migrate
  Caddyfile
  scripts/                     bootstrap.sh, backup.sh, restore.sh
docs/
```

## Docker Compose services
| Service | Image / build | Exposed |
|---|---|---|
| `caddy` | `caddy:2` | 80, 443 (only public ports) |
| `web` | `infra/docker/web.Dockerfile` | internal :3000 |
| `inngest` | `inngest/inngest` (`inngest start` with `--postgres-uri`, `--redis-uri`, event key, signing key) | internal :8288 (dashboard via SSH tunnel only) |
| `postgres` | `postgres:16` (volume; DBs `app` and `inngest`) | internal |
| `redis` | `redis:7` (AOF on, volume) | internal |
| `migrate` | web image, `prisma migrate deploy`, one-shot | — |

Caddy routes everything for `{$DOMAIN}` to `web:3000`, with a 2 MB body limit on `/api/ingest/*`.

## Environment variables
```
PUBLIC_URL=
DATABASE_URL=                 # app DB
REDIS_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
GITHUB_CLIENT_ID=             # GitHub App's OAuth client, used by Better Auth for login
GITHUB_CLIENT_SECRET=
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
INNGEST_BASE_URL=http://inngest:8288
ENCRYPTION_KEY=               # 32 bytes base64, for ChatGPT tokens
ANTHROPIC_API_KEY=            # platform default provider
OPENAI_API_KEY=               # optional platform fallback
CHATGPT_OAUTH_CLIENT_ID=      # Sign in with ChatGPT
CHATGPT_OAUTH_CLIENT_SECRET=
```

## Before coding against a library
Check its current docs for exact APIs (Better Auth organization plugin, Inngest TypeScript SDK and
self-hosting flags, Next.js route handlers, Sign in with ChatGPT). Mark any assumption in code with
`// VERIFY:` and list them in the PR description.

---

## Prompt to give Claude Code
Copy this into a Claude Code session at the repo root:

> Read `docs/tech-stack.md`. It is the decided stack and overrides anything else in the repo.
> Update `CLAUDE.md`, `docs/prd.md`, `docs/architecture.md`, `docs/essential-architecture.md` and every file in
> `tasks/` so they match it:
> - Remove `apps/api` and `apps/worker`; move webhook, ingest and job code into `apps/web/src/server/`
>   (github, ingest, jobs) and update folder ownership per lane.
> - Replace Fastify with Next.js route handlers, BullMQ with Inngest functions (one `step.run` per chunk),
>   Auth.js with Better Auth (GitHub login + organization plugin), and any tRPC mention with REST + shared zod schemas.
> - Add the Inngest server to Docker Compose and the env vars listed in tech-stack.md.
> - Keep everything else (providers, review states, error codes, risk scoring, security rules) unchanged.
> - Don't write application code yet. When done, list every file you changed and anything you were unsure about.

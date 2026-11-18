# CLAUDE.md — AI Code Review Platform

Read this file at the start of every session. Then read `docs/tech-stack.md` (it wins over every other doc),
`docs/essential-architecture.md`, and your task file in `tasks/`.

## What we are building
A multi-tenant SaaS that reviews GitHub pull requests with AI. Users pick a reviewer per repo
(Claude via their own GitHub Action, Codex via Sign in with ChatGPT, Codex via their own Action,
or the platform default). Every path produces the same `ReviewResult` JSON. The platform computes
a risk score, stores history, posts inline PR comments, and shows a dashboard.

## Stack (details: `docs/tech-stack.md`)
- Monorepo: pnpm workspaces + Turborepo, TypeScript (strict) everywhere
- `apps/web`: the ONE app. Next.js (App Router) + React + Tailwind + shadcn/ui. UI, REST route handlers
  (`src/app/api/**/route.ts`), webhook + ingest endpoints, and the Inngest endpoint `/api/inngest`.
  No separate API server, no worker app, no tRPC.
- Auth: Better Auth (GitHub social login + organization plugin for orgs, members, roles)
- Background jobs: Inngest (self-hosted) functions in `apps/web/src/server/jobs`
- Data fetching: TanStack Query hooks over one typed `apiFetch` client
- `packages/db`: Prisma + PostgreSQL 16 · Redis 7 (Inngest, webhook dedupe, rate limits)
- `packages/shared`: contracts (zod API schemas, Inngest event schemas, enums, provider interface, crypto/token utils)
- Tests: Vitest (unit/integration), Playwright (e2e smoke). HTTP mocking: msw or nock.

## Folder ownership (STRICT)
All `apps/web/src/...` paths below are relative to the repo root.

| Path | Owner |
|---|---|
| root config, `packages/shared`, `packages/db`, `docker-compose.dev.yml`, `.env.example`, `CLAUDE.md`, `apps/web/src/server/{auth,env,redis,logger}.ts`, `apps/web/src/app/api/{auth,inngest,health}/` | Foundation |
| `packages/github`, `apps/web/src/server/github/`, `apps/web/src/app/api/webhooks/github/` | A — GitHub integration |
| `apps/web/src/server/jobs/` (Inngest client + functions) | B — Jobs |
| `packages/providers/` | C — AI providers |
| `apps/web/src/server/ingest/`, `apps/web/src/app/api/ingest/`, `packages/workflow-templates/` | D — Ingest + Actions |
| `packages/scoring/`, `packages/github-comments/` | E — Scoring + comments |
| `apps/web/src/app/` (pages + dashboard API routes, except the API folders owned above), `apps/web/src/components/`, `apps/web/src/hooks/`, `apps/web/src/lib/` | F — Frontend |
| `infra/`, `.github/workflows/`, `docs/deploy.md` | G — Infra |

**Rules**
1. Only edit files inside the paths your task owns.
2. Never edit `packages/shared` or `packages/db` unless your task is Foundation. If you need a contract
   change, STOP and write the proposed change in `tasks/CONTRACT_REQUESTS.md`, then continue with a local
   workaround or mock.
3. Import other lanes only through their public entry: a package's `src/index.ts`, or for folders inside
   `apps/web` the folder's `index.ts` (e.g. `@/server/jobs`, `@/server/github`). If it is not merged yet,
   use the mock described in your task file.
4. `apps/web/package.json` is the one file several lanes touch (to add dependencies). Only add the lines you
   need; on merge conflicts keep the union of dependencies.
5. Every lane ships with tests. `pnpm turbo test --filter <your-package>` (for `apps/web` lanes:
   `pnpm --filter @app/web test -- <your folder>`) must pass before you open a PR.
6. No secrets in code. Read config from env (see `.env.example`). Never log tokens, keys, or code contents.

## Security non-negotiables
- The platform NEVER stores or receives a user's Claude OAuth token or their OpenAI API key used in Actions.
  Those live only in the user's GitHub repo secrets.
- Sign in with ChatGPT tokens are stored encrypted (`encrypt()` from `@app/shared`).
- Ingest tokens are stored hashed only (`hashToken()` from `@app/shared`).
- Verify GitHub webhook signatures (HMAC SHA-256) with timing-safe compare.
- Treat AI output and ingest payloads as untrusted: validate with zod, escape markdown, drop issues whose
  file/line is not in the PR diff.
- Never send to an AI provider: `.env*`, `*.pem`, `*.key`, lockfiles, files matching repo ignore settings.
- Inngest event payloads carry ids only — never code, patches or tokens.
- Every dashboard route checks the Better Auth session **and** org membership for the requested resource.

## Commands
```bash
pnpm install
cp .env.example .env                             # one .env at the repo root (app, Prisma, compose)
docker compose -f docker-compose.dev.yml up -d   # postgres + redis + inngest dev server
pnpm db:migrate                                  # prisma migrate dev
pnpm db:seed                                     # one org/repo/PR + a review in each status
pnpm dev                                         # next dev (apps/web)
pnpm turbo test                                  # all tests
pnpm turbo lint typecheck
```
Inngest dev UI: http://localhost:8288

## Conventions
- Package names: `@app/<name>`. Each package exports from `src/index.ts`. The app is `@app/web`.
- REST + zod: every endpoint's request/response schema lives in `packages/shared/src/api/<area>.ts`.
  Handlers `schema.parse` input (400 on failure); errors are `{ error: { code, message } }`.
- Errors that reach users map to an `ErrorCode` from `@app/shared`.
- Library APIs you are not sure of (Better Auth, Inngest, Next.js, Sign in with ChatGPT, GitHub Actions):
  check current docs; mark assumptions with `// VERIFY:` and list them in the PR description.
- Logging: `pino` via `logger` from `@/server/logger`, structured, include `reviewId` / `repoId` where relevant.
- Client components import contracts from `@app/shared/client` (no `node:crypto`); server code uses `@app/shared`.
- Route handlers: `throw new HttpError(code, msg)` and `catch (e) { return errorResponse(e) }` (both from
  `@app/shared`); auth with `requireSession(req)` + `requireOrgMember(userId, orgId)` from `@/server/auth`.
- Send Inngest events with `inngest` from `@/server/jobs` (typed by `eventSchemas` in `@app/shared`).
- Small commits, conventional messages (`feat(jobs): …`, `fix(web): …`).
- When done: open a PR from your branch to `main` with a description of what changed, why, how it was
  tested, and anything left undone. Codex will review it.

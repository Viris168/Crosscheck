# CLAUDE.md — AI Code Review Platform

Read this file at the start of every session. Then read your task file in `tasks/`.

## What we are building
A multi-tenant SaaS that reviews GitHub pull requests with AI. Users pick a reviewer per repo
(Claude via their own GitHub Action, Codex via Sign in with ChatGPT, Codex via their own Action,
or the platform default). Every path produces the same `ReviewResult` JSON. The platform computes
a risk score, stores history, posts inline PR comments, and shows a dashboard.

## Stack
- Monorepo: pnpm workspaces + Turborepo, TypeScript (strict) everywhere
- `apps/web`: Next.js (App Router) + Tailwind + Auth.js (GitHub login). Includes dashboard read API routes.
- `apps/api`: Fastify. Only public machine endpoints: GitHub webhooks + Action result ingest.
- `apps/worker`: BullMQ worker (Redis)
- `packages/db`: Prisma + PostgreSQL
- `packages/shared`: contracts (zod schemas, enums, job payloads, provider interface, crypto/token utils)
- Tests: Vitest. HTTP mocking: msw or nock.

## Folder ownership (STRICT)
| Path | Owner |
|---|---|
| root config, `packages/shared`, `packages/db`, `apps/api/src/server.ts`, `docker-compose.dev.yml`, `.env.example`, `CLAUDE.md` | Foundation |
| `packages/github`, `apps/api/src/github/` | A — GitHub integration |
| `apps/worker/` | B — Review worker |
| `packages/providers/` | C — AI providers |
| `apps/api/src/ingest/`, `packages/workflow-templates/` | D — Ingest + Actions |
| `packages/scoring/`, `packages/github-comments/` | E — Scoring + comments |
| `apps/web/` | F — Frontend |
| `infra/`, `.github/workflows/`, `docs/deploy.md` | G — Infra |

**Rules**
1. Only edit files inside the paths your task owns.
2. Never edit `packages/shared` or `packages/db` unless your task is Foundation. If you need a contract
   change, STOP and write the proposed change in `tasks/CONTRACT_REQUESTS.md`, then continue with a local
   workaround or mock.
3. Import other lanes only through their package's public `index.ts`. If that package is not ready, use the
   mock described in your task file.
4. Every lane ships with tests. `pnpm turbo test --filter <your-package>` must pass before you open a PR.
5. No secrets in code. Read config from env (see `.env.example`). Never log tokens, keys, or code contents.

## Security non-negotiables
- The platform NEVER stores or receives a user's Claude OAuth token or their OpenAI API key used in Actions.
  Those live only in the user's GitHub repo secrets.
- Sign in with ChatGPT tokens are stored encrypted (`encrypt()` from `@app/shared`).
- Ingest tokens are stored hashed only (`hashToken()` from `@app/shared`).
- Verify GitHub webhook signatures (HMAC SHA-256) with timing-safe compare.
- Treat AI output and ingest payloads as untrusted: validate with zod, escape markdown, drop issues whose
  file/line is not in the PR diff.
- Never send to an AI provider: `.env*`, `*.pem`, `*.key`, lockfiles, files matching repo ignore settings.

## Commands
```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # postgres + redis
pnpm db:migrate                                  # prisma migrate dev
pnpm dev                                         # all apps
pnpm turbo test                                  # all tests
pnpm turbo lint typecheck
```

## Conventions
- Package names: `@app/<name>`. Each package exports from `src/index.ts`.
- Errors that reach users map to an `ErrorCode` from `@app/shared`.
- Logging: `pino`, structured, include `reviewId` / `repoId` where relevant.
- Small commits, conventional messages (`feat(worker): …`, `fix(web): …`).
- When done: open a PR from your branch to `main` with a description of what changed, why, how it was
  tested, and anything left undone. Codex will review it.

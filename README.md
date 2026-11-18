# AI Code Review Platform

Multi-tenant SaaS that reviews GitHub pull requests with AI. Start with [`CLAUDE.md`](CLAUDE.md),
[`docs/tech-stack.md`](docs/tech-stack.md) and [`docs/essential-architecture.md`](docs/essential-architecture.md).

## Quick start

Requires Node 22+, pnpm 11, Docker.

```bash
pnpm install
cp .env.example .env            # fill BETTER_AUTH_SECRET, ENCRYPTION_KEY (openssl rand -base64 32)
docker compose -f docker-compose.dev.yml up -d
pnpm db:migrate
pnpm db:seed
pnpm dev                        # http://localhost:3000 · Inngest dev UI http://localhost:8288
```

Ports 5432/6379/8288 taken? Set `POSTGRES_PORT` / `REDIS_PORT` / `INNGEST_PORT` in `.env` and update
`DATABASE_URL` / `REDIS_URL` / `INNGEST_BASE_URL` to match.

GitHub login: create a GitHub OAuth app (or use the GitHub App's OAuth client) with callback
`http://localhost:3000/api/auth/callback/github`, then set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

```bash
pnpm turbo build test lint typecheck
```

## Layout

| Path | What |
|---|---|
| `apps/web` | The one Next.js app: UI, REST route handlers, webhook/ingest endpoints, Inngest endpoint |
| `packages/shared` | Contracts: zod API schemas, Inngest events, enums, provider interface, crypto |
| `packages/db` | Prisma schema, migrations, seed, `prisma` client |
| `packages/{github,providers,scoring,github-comments,workflow-templates}` | Lane packages |

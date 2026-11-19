# Task G — Infra, CI/CD, production deploy

**Branch:** `feat/g-infra` · **Phase 3** (can start any time after Foundation) · **Depends on:** Foundation

## Goal
One-command production deploy on a single VPS with Docker + automatic HTTPS, CI on every PR, backups,
and basic monitoring.

## Scope now: free local demo (no VPS)
This project is currently a **demo with a $0 budget**. There is no VPS, no domain and no paid service.
The demo runs on the developer's laptop. So:
- **Build and test everything locally:** Dockerfile, `infra/compose.prod.yml` in `localhost` Caddy mode,
  scripts, CI. Keep the VPS design below intact so it can be deployed later without rework.
- **CI (`ci.yml`) must run with no secrets** and stay inside GitHub's free tier (public repo).
- **`deploy.yml` must never fail or run on its own:** trigger it with `workflow_dispatch` only, and skip
  with a clear message when `VPS_HOST` is not set. No automatic deploy on push to `main`.
- **Don't** buy, sign up for, or depend on anything paid (hosting, domains, Sentry, S3, uptime services).
  Optional extras stay documented placeholders.
- **`docs/deploy.md` starts with a "Local demo" section:** `docker-compose.dev.yml` + `pnpm dev`, a free
  smee.io channel for GitHub webhooks, an optional free Cloudflare quick tunnel
  (`cloudflared tunnel --url http://localhost:3000`) to share a temporary public link, and free reviewer
  choices (Claude Action on the user's own Claude plan, in a public repo where Actions are free). Note
  that the platform-default reviewer uses `ANTHROPIC_API_KEY`, which is paid per review.
- The VPS guide follows as "Later: deploy to a VPS". Mention Oracle Cloud Always Free as a $0 VM option
  (ARM: the image must build for `linux/arm64`, so make the Dockerfile multi-arch friendly).

## You own
`infra/`, `.github/workflows/`, `docs/deploy.md`

## Do not touch
Application code in `apps/*` or `packages/*`. If an app needs a change to run in production (e.g. a
build flag), write it in `tasks/CONTRACT_REQUESTS.md`.

## Build

### Docker
- `infra/docker/web.Dockerfile` (the only app image): multi-stage, turbo prune, Next.js `output: 'standalone'`
  (if `apps/web/next.config` lacks it, file a request in `tasks/CONTRACT_REQUESTS.md`), Node LTS slim,
  non-root user, healthcheck on `/api/health`
- `infra/compose.prod.yml` services (see `docs/tech-stack.md` → Docker Compose services):
  - `caddy` (`caddy:2`) — the only service with public ports 80/443
  - `web` — internal :3000
  - `inngest` (`inngest/inngest`, `inngest start` with `--postgres-uri` (DB `inngest`), `--redis-uri`,
    event key, signing key; app URL `http://web:3000/api/inngest`) — internal :8288, dashboard via SSH
    tunnel only. `# VERIFY:` flags against Inngest's current self-hosting docs.
  - `postgres` (`postgres:16`, volume, init script creating DBs `app` and `inngest`)
  - `redis` (`redis:7`, AOF on, volume)
  - `migrate` (web image, one-shot `prisma migrate deploy` before `web` starts)
- Everything except Caddy on an internal network.

### Caddy (`infra/Caddyfile`)
- `{$DOMAIN}` → automatic Let's Encrypt HTTPS
- Everything → `web:3000` (there is no separate API server)
- Never expose `inngest` publicly
- Security headers (HSTS, X-Content-Type-Options, frame-ancestors none), request body limit 2 MB on `/api/ingest`

### Server setup (`infra/scripts/bootstrap.sh`, idempotent)
Ubuntu LTS: create deploy user, SSH key only, disable password login, UFW allow 22/80/443, install Docker,
unattended-upgrades, fail2ban.

### CI/CD (`.github/workflows/`)
- `ci.yml` on PR: install (cached), `turbo lint typecheck test build`, Postgres + Redis service containers,
  Playwright smoke (`apps/web`)
- `deploy.yml` on push to `main` (after CI): build + push the web image to GHCR with sha tags, SSH to VPS,
  `docker compose pull && docker compose up -d`, run healthcheck, auto-rollback to previous tag on failure
- Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`; app env lives in `/opt/app/.env` on the server (not in GitHub)

### Ops
- `infra/scripts/backup.sh`: nightly `pg_dump` (cron), gzip, keep 7 daily + 4 weekly, optional upload to S3-compatible storage
- `infra/scripts/restore.sh` and a tested restore section in docs
- Backups cover both Postgres DBs (`app`, `inngest`)
- Uptime: healthcheck endpoint `/api/health` + instructions for an external uptime monitor; container logs
  rotated (json-file max-size)
- Optional: Sentry DSN env for web

### `docs/deploy.md`
Step-by-step: buy domain → DNS A record → run bootstrap → create GitHub App (permissions: Pull requests
R/W, Contents R, Checks R/W, Metadata R, Issues R for comments; events: pull_request, issue_comment,
installation, installation_repositories; webhook URL `https://DOMAIN/api/webhooks/github`; OAuth callback
URL for Better Auth login `https://DOMAIN/api/auth/callback/github`) → generate `BETTER_AUTH_SECRET`,
`ENCRYPTION_KEY`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` → fill `.env` (all vars in `.env.example`,
`INNGEST_BASE_URL=http://inngest:8288`) → first deploy → verify (incl. Inngest dashboard via SSH tunnel).

## Done when
- [ ] `docker compose -f infra/compose.prod.yml up` works locally in `localhost` Caddy mode (`/api/health` 200)
- [ ] CI passes on a sample PR with no repo secrets set
- [ ] `deploy.yml` is manual-only and skips cleanly when `VPS_HOST` is not set
- [ ] Backup + restore tested once locally and documented
- [ ] `docs/deploy.md`: "Local demo" section first, then "Later: deploy to a VPS"
- [ ] ~~Deploy to a real VPS~~ — deferred (no budget); the steps are documented, not executed

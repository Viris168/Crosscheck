# Task G — Infra, CI/CD, production deploy

**Branch:** `feat/g-infra` · **Phase 3** (can start any time after Foundation) · **Depends on:** Foundation

## Goal
One-command production deploy on a single VPS with Docker + automatic HTTPS, CI on every PR, backups,
and basic monitoring.

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
- [ ] `docker compose -f infra/compose.prod.yml up` works locally with a test domain (or `localhost` Caddy mode)
- [ ] CI passes on a sample PR
- [ ] Deploy to a real VPS succeeds; HTTPS valid; GitHub webhook delivery shows 200
- [ ] Backup + restore tested once and documented

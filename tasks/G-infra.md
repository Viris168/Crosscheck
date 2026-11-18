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
- `infra/docker/web.Dockerfile`, `api.Dockerfile`, `worker.Dockerfile`: multi-stage, `pnpm deploy`/turbo
  prune, Node LTS slim, non-root user, healthchecks
- `infra/compose.prod.yml` services: `caddy`, `web`, `api`, `worker` (scalable), `postgres` (volume),
  `redis` (AOF on, volume), `migrate` (one-shot `prisma migrate deploy` before web/api/worker start)
- Only Caddy exposes ports 80/443. Everything else on an internal network.

### Caddy (`infra/Caddyfile`)
- `{$DOMAIN}` → automatic Let's Encrypt HTTPS
- `/api/webhooks/*` and `/api/ingest/*` → `api:4000`; everything else → `web:3000`
- Security headers (HSTS, X-Content-Type-Options, frame-ancestors none), request body limit 2 MB on `/api/ingest`

### Server setup (`infra/scripts/bootstrap.sh`, idempotent)
Ubuntu LTS: create deploy user, SSH key only, disable password login, UFW allow 22/80/443, install Docker,
unattended-upgrades, fail2ban.

### CI/CD (`.github/workflows/`)
- `ci.yml` on PR: install (cached), `turbo lint typecheck test build`, Postgres + Redis service containers
- `deploy.yml` on push to `main` (after CI): build + push images to GHCR with sha tags, SSH to VPS,
  `docker compose pull && docker compose up -d`, run healthcheck, auto-rollback to previous tag on failure
- Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`; app env lives in `/opt/app/.env` on the server (not in GitHub)

### Ops
- `infra/scripts/backup.sh`: nightly `pg_dump` (cron), gzip, keep 7 daily + 4 weekly, optional upload to S3-compatible storage
- `infra/scripts/restore.sh` and a tested restore section in docs
- Uptime: healthcheck endpoints (`/health` on api, `/api/health` on web) + instructions for an external
  uptime monitor; container logs rotated (json-file max-size)
- Optional: Sentry DSN env for web/api/worker

### `docs/deploy.md`
Step-by-step: buy domain → DNS A record → run bootstrap → create GitHub App (permissions: Pull requests
R/W, Contents R, Checks R/W, Metadata R, Issues R for comments; events: pull_request, issue_comment,
installation, installation_repositories; webhook URL `https://DOMAIN/api/webhooks/github`) → fill `.env` →
first deploy → verify.

## Done when
- [ ] `docker compose -f infra/compose.prod.yml up` works locally with a test domain (or `localhost` Caddy mode)
- [ ] CI passes on a sample PR
- [ ] Deploy to a real VPS succeeds; HTTPS valid; GitHub webhook delivery shows 200
- [ ] Backup + restore tested once and documented

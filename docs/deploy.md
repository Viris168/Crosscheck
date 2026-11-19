# Deploy

**Now: a free local demo.** The app runs on your laptop; nothing here costs money. (Exception: the
*platform default* reviewer calls the Anthropic API with `ANTHROPIC_API_KEY`, which is billed per review.)
**Later:** the same Docker setup deploys to one VPS. That guide is kept below, ready, but not used yet.

| | |
|---|---|
| [1. Local demo](#1-local-demo-0) | `pnpm dev` + dev compose, GitHub webhooks via smee.io, optional public link via Cloudflare quick tunnel |
| [2. Production stack locally](#2-optional-run-the-production-stack-locally-localhost-mode) | Optional check of the Docker image + Caddy |
| [3. Later: deploy to a VPS](#3-later-deploy-to-a-vps) | Domain, server, GitHub App, manual `Deploy` workflow |

---

## 1. Local demo ($0)
```
GitHub ──webhooks──▶ smee.io ──▶ your laptop: pnpm dev (:3000) + docker-compose.dev.yml (postgres, redis, inngest)
GitHub Action ──review.json──▶ Cloudflare quick tunnel ──▶ your laptop (only for the Claude/Codex Action reviewers)
You / viewers ──▶ http://localhost:3000  (or the tunnel's https://…trycloudflare.com link)
```

### 1.1 Run the app
```bash
pnpm install
cp .env.example .env
#   BETTER_AUTH_SECRET=$(openssl rand -base64 32)   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   ports taken on this machine? set POSTGRES_PORT / REDIS_PORT (and DATABASE_URL / REDIS_URL to match)
docker compose -f docker-compose.dev.yml up -d     # postgres + redis + inngest dev server
pnpm db:migrate && pnpm db:seed                    # seed: one org/repo/PR + a review in each status
pnpm dev                                           # http://localhost:3000 · Inngest UI http://localhost:8288
```
After a reboot only `docker compose -f docker-compose.dev.yml up -d` and `pnpm dev` are needed again.

### 1.2 GitHub App for the demo (free)
Create one under GitHub → Settings → Developer settings → GitHub Apps (permissions + events as in
[3.3](#33-create-the-github-app)), with:
- **Webhook URL:** a free channel from <https://smee.io> (click "Start a new channel").
- **Callback URL:** `http://localhost:3000/api/auth/callback/github` (or the tunnel URL, see 1.4).
- Put `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET` in `.env`.

Relay the webhooks to your laptop while you demo:
```bash
npx smee-client -u https://smee.io/<your-channel> -t http://localhost:3000/api/webhooks/github
```
Install the App on a **public** test repo (GitHub Actions minutes are free for public repos).

### 1.3 Pick a free reviewer
| Reviewer | Cost | Needs |
|---|---|---|
| **Claude Action** | $0 extra on an existing Claude Pro/Max plan | Repo secrets `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) + `PLATFORM_INGEST_TOKEN` (shown once by the setup wizard; rotate it in repo settings). **And a public URL** (1.4): the Action runs on GitHub and POSTs its result to `PUBLIC_URL/api/ingest/review`. |
| Codex · Sign in with ChatGPT | $0 extra on an existing ChatGPT plan | `CHATGPT_OAUTH_CLIENT_ID/SECRET` |
| Platform default | **Paid** per review | `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) |

The setup wizard in the dashboard (`/repos/<id>/setup`) commits the workflow file and lists the secrets.

### 1.4 Optional: a public link (Cloudflare quick tunnel, no account, no domain)
```bash
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```
Then set `PUBLIC_URL` and `BETTER_AUTH_URL` to that URL in `.env`, restart `pnpm dev`, and update the App's
callback URL (and, if you like, its webhook URL instead of smee). The URL changes on every start and the
link only works while your laptop runs it, which is fine for a live demo or a recording.

---

## 2. Optional: run the production stack locally (localhost mode)
Checks the production Docker image, Caddy and `compose.prod.yml` on your machine, with Caddy's internal CA instead of Let's Encrypt:
```bash
cp infra/env.prod.example /tmp/prod-local.env    # anywhere outside git
# edit: DOMAIN=localhost, PUBLIC_URL/BETTER_AUTH_URL=https://localhost, POSTGRES_PASSWORD, the secrets
#       (+ INNGEST_DASHBOARD_PORT=18288 / HTTP_PORT / HTTPS_PORT if those host ports are taken)
APP_ENV_FILE=/tmp/prod-local.env STATE_DIR=/tmp/prod-local-state infra/scripts/compose.sh up -d --build
curl -k https://localhost/api/health
APP_ENV_FILE=/tmp/prod-local.env infra/scripts/compose.sh down -v     # -v also deletes the volumes
```
Postgres and Redis publish no host ports, so they don't clash with a local dev stack on 5432/6379.

---

## 3. Later: deploy to a VPS
Not used in the demo. Follow this when there is a server (paid VPS, or Oracle Cloud Always Free).

Production (later) runs the stack in `infra/compose.prod.yml` on one Ubuntu LTS VPS (~2 vCPU / 4 GB RAM):

| Service | What | Reachable from |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt), security headers, 2 MB body limit on `/api/ingest` | internet: 80, 443 |
| `web` | the Next.js app (`infra/docker/web.Dockerfile`), GHCR image `ghcr.io/<owner>/<repo>-web:sha-<commit>` | caddy, inngest |
| `migrate` | same image, one-shot `prisma migrate deploy`; `web` starts after it exits 0 | — |
| `inngest` | self-hosted Inngest (`inngest start`, Postgres DB `inngest` + Redis) | web; dashboard on the VPS's `127.0.0.1:8288` (SSH tunnel) |
| `postgres` | Postgres 16, DBs `app` and `inngest`, volume `pgdata` | internal network only |
| `redis` | Redis 7, AOF on, volume `redisdata` | internal network only |

Server layout:
```
/opt/app/.env          app + infra env (chmod 600) — template: infra/env.prod.example
/opt/app/infra/        copied from the repo by every deploy (compose file, Caddyfile, scripts)
/opt/app/.deploy/      web_image, current_tag, previous_tag (written by deploy.sh)
/opt/app/backups/      daily/ weekly/ dumps + backup.log
/opt/app/backup.env    optional: S3 credentials for off-site backups
```
Day-to-day commands go through `infra/scripts/compose.sh` (it passes `/opt/app/.env` and the deployed tag):
`compose.sh ps`, `compose.sh logs -f web`, `compose.sh restart web`.


### 3.1 Domain + DNS
1. Get a domain (any registrar).
2. Create a VPS (Ubuntu 24.04 LTS) and note its IPv4 (and IPv6 if any). **$0 option:** an Oracle Cloud
   "Always Free" Ampere (ARM) VM fits this stack; `deploy.yml` builds the image for `linux/arm64` too.
   Check Oracle's current free-tier terms (card needed for verification, capacity varies by region).
3. DNS: `A  review.example.com → <VPS IPv4>` (plus `AAAA` → IPv6 if the VPS has one). Low TTL (300) at first.
   Check: `dig +short review.example.com` returns the VPS IP. Caddy can't get a certificate before this resolves.

### 3.2 Bootstrap the server (once)
From your laptop, with root SSH access from the provider:
```bash
scp infra/scripts/bootstrap.sh root@VPS:/root/
ssh root@VPS "DEPLOY_PUBKEY='$(cat ~/.ssh/id_ed25519.pub)' bash /root/bootstrap.sh"
```
It is idempotent (safe to re-run) and: creates user `deploy` (SSH key only, in the `docker` group), disables
password + root SSH login, enables UFW (22, 80, 443), installs Docker + compose plugin, unattended-upgrades,
fail2ban, Docker log rotation, `/opt/app`, and a nightly backup cron (03:15 UTC).
Then check you can log in as `ssh deploy@VPS` **before** closing the root session.

Create a separate key pair for GitHub Actions and authorize it for `deploy`:
```bash
ssh-keygen -t ed25519 -f deploy_ci -N '' -C github-actions-deploy
ssh deploy@VPS "cat >> ~/.ssh/authorized_keys" < deploy_ci.pub
ssh-keyscan -H VPS            # → optional secret VPS_KNOWN_HOSTS (pins the host key)
```

### 3.3 Create the GitHub App
GitHub → Settings → Developer settings → GitHub Apps → New (or under your org).
- **Homepage URL:** `https://DOMAIN`
- **Callback URL** (Better Auth login): `https://DOMAIN/api/auth/callback/github`
- **Webhook URL:** `https://DOMAIN/api/webhooks/github` · **Webhook secret:** `openssl rand -hex 32`
- **Repository permissions:** Pull requests **Read & write**, Contents **Read & write** (write is only
  for the dashboard's Merge button), Checks **Read & write**, Metadata **Read**, Issues **Read** (for comments)
- Raising a permission on an existing App: GitHub asks each installation's owner to accept it
  (org/user Settings → GitHub Apps → Configure → *Review request*). Until they do, Merge returns 403.
- **Organization permissions:** Members **Read** (sign-in sync checks GitHub org membership)
- **Subscribe to events:** Pull request, Issue comment, Installation (always on), Installation
  repositories, Organization, Member
- **User-to-server tokens:** keep **Expire user authorization tokens** on (the default). Login uses the
  App's own OAuth client (`GITHUB_CLIENT_ID`), so Better Auth stores a GitHub App user token, and the
  sign-in sync calls `GET /user/installations` with it. Those tokens last 8 hours and come with a
  6-month refresh token; Better Auth refreshes them
  ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).
  If the refresh token has expired too, the sync can only remove access until the user signs in again.
- Generate a **private key** (.pem) and a **client secret**. Note App ID + Client ID.

<!-- VERIFY: /user/installations accepts the stored GitHub App user token; Member event needs the
Members org permission (and how it behaves on personal installs); a missing Members permission
answers 403 (not 404). -->

#### Upgrading an existing install
Adding Members **Read** and the Organization/Member events changes the App's permissions, so GitHub asks
each installation's owner to accept them (GitHub emails org owners; org/user Settings → GitHub Apps →
Configure → *Review request*). See GitHub's
[approving updated permissions](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app).
Until the client accepts:
- members don't join or leave automatically (GitHub answers the membership check with an error, and
  the platform changes nothing),
- the org owner sees a banner on **Settings → Members**: "Accept the new GitHub App permissions to sync
  members".

Accepting sends `installation.new_permissions_accepted`, which clears the banner; members sync at their
next sign-in or via **Check again**.

### 3.4 Secrets
```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (must decode to 32 bytes)
openssl rand -hex 32      # INNGEST_EVENT_KEY
openssl rand -hex 32      # INNGEST_SIGNING_KEY  (Inngest requires hex, even length)
openssl rand -hex 24      # POSTGRES_PASSWORD (hex keeps the DB URL valid)
```

### 3.5 Fill `/opt/app/.env`
```bash
scp infra/env.prod.example deploy@VPS:/opt/app/.env
ssh deploy@VPS 'chmod 600 /opt/app/.env && nano /opt/app/.env'
```
Fill every variable of `.env.example` plus `DOMAIN` and `POSTGRES_PASSWORD`:
- `PUBLIC_URL` and `BETTER_AUTH_URL` = `https://DOMAIN`
- `GITHUB_APP_PRIVATE_KEY`: the PEM on one line, newlines as `\n`, in double quotes:
  `awk 'NF {printf "%s\\n", $0}' app.private-key.pem`
- `DATABASE_URL`, `REDIS_URL`, `INNGEST_BASE_URL=http://inngest:8288` and `INNGEST_DEV=0` are **set by
  `compose.prod.yml`** from the service names and `POSTGRES_PASSWORD`; leave them out or they're ignored.
- App secrets live only here, never in GitHub. The platform never receives users' Claude OAuth tokens or the
  OpenAI keys their Actions use (those stay in each user's repo secrets).

### 3.6 GitHub repo settings
- **Secrets → Actions:** `VPS_HOST` (IP or hostname), `VPS_USER` (`deploy`), `VPS_SSH_KEY` (contents of
  `deploy_ci`), optional `VPS_KNOWN_HOSTS` (the `ssh-keyscan -H` output; without it the host key is trusted
  on first use in every run).
- **Environments:** create `production` (add required reviewers if you want a manual gate).
- **Branch protection on `main`:** require the `CI` checks.
- The image goes to GHCR as `ghcr.io/<owner>/<repo>-web` using the workflow's `GITHUB_TOKEN`; nothing to set up.
  The server logs in to GHCR only for the duration of each deploy.

### 3.7 Deploy
**Manual only:** Actions → Deploy → Run workflow (`.github/workflows/deploy.yml`). Nothing deploys on push.
Without the `VPS_HOST` secret the run skips with a notice. With it:
1. builds + pushes `ghcr.io/<owner>/<repo>-web:sha-<commit>` (and `:main`) for `linux/amd64` + `linux/arm64`
   (input `platforms` to change),
2. rsyncs `infra/` to `/opt/app/infra/`,
3. runs `infra/scripts/deploy.sh sha-<commit>` on the server: pull → `migrate` → `web` → waits until the
   container healthcheck **and** `https://DOMAIN/api/health` through Caddy answer (180 s),
4. if that fails: re-deploys the previous tag (`/opt/app/.deploy/current_tag`) and the job fails.

Input `tag`: empty = build the selected branch; an existing tag = redeploy it. On the server: `/opt/app/infra/scripts/deploy.sh --rollback` goes back one tag.

> Migrations are **not** rolled back. Keep them backward compatible (add columns/tables first, remove in a
> later release), and run `backup.sh` before a risky one.

### 3.8 Verify
```bash
curl -fsS https://DOMAIN/api/health                 # {"ok":true}
curl -sI https://DOMAIN | grep -iE 'strict-transport|x-content-type|content-security'
curl -s -o /dev/null -w '%{http_code}\n' https://DOMAIN/api/inngest   # 404 (not exposed publicly)
ssh deploy@VPS /opt/app/infra/scripts/compose.sh ps  # all running, web healthy, migrate exited 0
```
- Browser: `https://DOMAIN` → valid certificate (Let's Encrypt), "Sign in with GitHub" works.
- GitHub App → Advanced → Recent Deliveries: the `ping` / `installation` delivery shows **200**
  (redeliver one if needed). Install the App on a test repo and open a PR.
- **Inngest dashboard** (never public):
  ```bash
  ssh -N -L 8288:127.0.0.1:8288 deploy@VPS
  # open http://localhost:8288 → Apps: http://web:3000/api/inngest synced, functions review-start,
  # review-finalize, review-sweep listed; the sweep cron shows runs every 5 min.
  ```
  If the app isn't synced: `compose.sh logs inngest web` (signing key mismatch is the usual cause — the
  same `INNGEST_SIGNING_KEY` is passed to both).

### 3.9 Backups + restore
`infra/scripts/backup.sh` (cron 03:15 UTC, logs to `/opt/app/backups/backup.log`) dumps **both** databases
(`app`, `inngest`) with `pg_dump` → gzip into `/opt/app/backups/daily/`, copies Sunday's to `weekly/`, and
keeps 7 daily + 4 weekly per database.

**Off-site (recommended):** create `/opt/app/backup.env` (chmod 600):
```bash
S3_BUCKET=s3://my-bucket/ai-review
S3_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=auto
```
Uploads go to `daily/` and `weekly/` prefixes (via the `amazon/aws-cli` container); set a bucket lifecycle
rule to expire `daily/` after 8 days and `weekly/` after 35.

**Restore** (drops and recreates the database; stops `web` + `inngest` meanwhile):
```bash
/opt/app/infra/scripts/restore.sh app latest
/opt/app/infra/scripts/restore.sh inngest backups/daily/inngest-20261119-031500.sql.gz
FORCE=1 ...   # skip the confirmation prompt
```
From off-site: download the file first (`aws s3 cp s3://…/daily/app-….sql.gz /opt/app/backups/`).

**Tested restore procedure** (run once after setup, and after big schema changes):
1. `backup.sh` → note the row counts: `compose.sh exec -T postgres psql -U app -d app -c 'select count(*) from "Review"'`
2. Change data (or on a staging copy: `dropdb`), then `restore.sh app latest` (+ `inngest latest`).
3. Counts match again, `curl https://DOMAIN/api/health` is ok, the dashboard shows the old reviews, and the
   Inngest dashboard still lists past runs.

Verified locally on 2026-11-19 (localhost mode, see below): dumps of both DBs written, a row deleted after the
backup came back after `restore.sh app latest`, `web` healthy again afterwards.

### 3.10 Monitoring + logs
- **Uptime:** point an external monitor (free tiers exist: UptimeRobot, Healthchecks.io, …) at
  `https://DOMAIN/api/health`, every 1–5 min, alert on non-200 or keyword `"ok":true` missing. It covers DNS,
  TLS, Caddy and the app. Optional: a "heartbeat" check pinged by the backup cron
  (`backup.sh && curl -fsS https://hc-ping.com/<uuid>`) to alert when backups stop.
- **Container health:** `web` has a Docker healthcheck on `/api/health`; `compose.sh ps` shows it.
- **Logs:** `compose.sh logs -f --tail 200 web` (pino JSON), `caddy` (JSON access log), `inngest`.
  Rotation: json-file `max-size 10m`, `max-file 5` per container (compose file + Docker daemon default).
- **Disk:** `docker system df`; deploy.sh prunes images older than 7 days after a successful deploy.

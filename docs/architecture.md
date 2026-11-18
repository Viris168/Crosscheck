# Architecture — AI Code Review Platform

Full technical design. For the one-page version agents should load first, see
`docs/essential-architecture.md`. Product requirements: `docs/prd.md`.

---

## 1. System context

```mermaid
flowchart LR
  Dev[Developer] -->|opens PR| GH[GitHub]
  Dev -->|uses dashboard| Web
  GH -->|webhooks| API
  subgraph Platform [Our VPS - Docker Compose]
    Caddy[Caddy HTTPS] --> Web[apps/web - Next.js]
    Caddy --> API[apps/api - Fastify]
    API --> Redis[(Redis / BullMQ)]
    Web --> PG[(PostgreSQL)]
    API --> PG
    Worker[apps/worker] --> Redis
    Worker --> PG
  end
  Worker -->|platform / ChatGPT-plan calls| LLM[Anthropic / OpenAI]
  Worker -->|fetch diff, post review| GH
  GH -->|runs user's Action| GHA[User's GitHub Actions<br/>Claude Code / Codex]
  GHA -->|review.json| API
```

## 2. Components

| Component | Tech | Responsibility |
|---|---|---|
| `apps/web` | Next.js App Router, Tailwind, Auth.js | UI, GitHub login, dashboard read API (`/app/api/*`), settings, setup wizard, ChatGPT OAuth routes |
| `apps/api` | Fastify | Public machine endpoints only: `/api/webhooks/github`, `/api/ingest/review`, `/health` |
| `apps/worker` | BullMQ | Run reviews (chunking, provider calls), finalize (score + comments), sweep stuck reviews |
| `packages/shared` | TS + zod | Contracts: enums, `ReviewResult` schema, provider interface, job payloads, API shapes, crypto |
| `packages/db` | Prisma | Schema, migrations, client |
| `packages/github` | Octokit | App auth, installation tokens, PR/file fetch, webhook signature check |
| `packages/providers` | Anthropic/OpenAI SDKs | Prompt builder, provider implementations, output parsing, ChatGPT OAuth helpers |
| `packages/scoring` | TS | Risk formula |
| `packages/github-comments` | TS | Diff-line mapping, comment formatting, posting reviews |
| `packages/workflow-templates` | TS | Render Claude/Codex Action YAML, open setup PR |
| Infra | Docker, Caddy, Postgres 16, Redis 7 | Single VPS, auto HTTPS, backups |

Dependency rule: apps depend on packages; packages depend only on `shared`/`db` and each other's
public `index.ts`; no package depends on an app.

## 3. Provider modes

| `ProviderId` | `runsInWorker` | Credential location | Result path |
|---|---|---|---|
| `platform` | yes | Our env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) | Worker → DB |
| `codex_chatgpt` | yes | `ProviderCredential` (encrypted OAuth token from Sign in with ChatGPT) | Worker → DB |
| `claude_action` | no | User's repo secret `CLAUDE_CODE_OAUTH_TOKEN` (never reaches us) | Action → `/api/ingest/review` |
| `codex_action` | no | User's repo secret `OPENAI_API_KEY` (never reaches us) | Action → `/api/ingest/review` |

All four produce `ReviewResult` (schema v1). Everything after that is shared.

## 4. Main flows

### 4.1 Worker-run review (`platform`, `codex_chatgpt`)
```mermaid
sequenceDiagram
  participant GH as GitHub
  participant API as apps/api
  participant Q as Redis/BullMQ
  participant W as apps/worker
  participant P as Provider (LLM)
  participant DB as Postgres
  GH->>API: pull_request (opened/synchronize)
  API->>API: verify signature, dedupe delivery
  API->>DB: upsert PR, create Review(queued, headSha)
  API->>Q: review.start {reviewId}
  API-->>GH: 200 (<1s)
  W->>Q: take review.start
  W->>DB: status=running
  W->>GH: fetch files, AGENTS.md, CHANGE_NOTES.md
  W->>W: filter + chunk (~60k tokens)
  loop each chunk (concurrency 3)
    W->>P: reviewChunk(input)
    P-->>W: ReviewChunkResult (validated)
    W->>DB: insert issues, filesDone += n
  end
  W->>Q: review.finalize {reviewId}
  W->>W: computeRisk()
  W->>GH: create PR review (summary + inline comments)
  W->>DB: status=completed, risk, githubReviewId
```

### 4.2 Action-run review (`claude_action`, `codex_action`)
```mermaid
sequenceDiagram
  participant GH as GitHub
  participant API as apps/api
  participant A as User's Action
  participant Q as Redis/BullMQ
  participant W as apps/worker
  GH->>API: pull_request webhook
  API->>API: create Review(waiting_action)
  GH->>A: run ai-review.yml (same event)
  A->>A: Claude Code / Codex writes review.json
  A->>API: POST /api/ingest/review (Bearer ingest token)
  API->>API: hash token → repo, zod validate, check PR + head_sha
  API->>API: save issues
  API->>Q: review.finalize {reviewId}
  W->>GH: post review (same finalize as 4.1)
```

### 4.3 Sign in with ChatGPT
`/api/oauth/chatgpt/start` (web) → OpenAI authorize → `/api/oauth/chatgpt/callback` →
`chatgptOAuth.exchangeCode()` → `encrypt()` tokens → `ProviderCredential`. Worker refreshes on expiry and
saves back encrypted. Exact endpoints/scopes: verify against OpenAI's current developer docs.

### 4.4 Setup wizard: commit workflow
Web calls `openWorkflowPR()` (`@app/workflow-templates`) with an installation Octokit → branch
`ai-review/setup` → `.github/workflows/ai-review.yml` → PR listing required secrets.

## 5. Review state machine

```mermaid
stateDiagram-v2
  [*] --> queued: webhook (worker provider)
  [*] --> waiting_action: webhook (action provider)
  queued --> running: review.start
  running --> completed: finalize ok
  running --> failed: all chunks failed / timeout (20m)
  waiting_action --> completed: ingest + finalize
  waiting_action --> failed: no result (30m) / no_output
  failed --> queued: user Retry
  completed --> queued: user Re-run
```
`stale` is derived, not stored: `review.headSha !== pullRequest.headSha`.

### Error codes
| Code | Cause | User-facing fix |
|---|---|---|
| `too_large` | Over token budget (warning on completed, or failure) | Split PR / reviewed riskiest files |
| `provider_auth` | 401/403 from provider | Renew Claude token / reconnect ChatGPT |
| `rate_limited` | 429 / plan cap | Retry later / switch provider |
| `timeout` | Call > 90s or review > 20m | Retry |
| `action_missing` | No ingest in 30m | Check Action logs / secrets |
| `invalid_output` | AI JSON invalid after retry, or `no_output` | Retry |
| `github_error` | GitHub API failure | Retry; check app installation |
| `internal` | Bug | Contact support with review id |

## 6. Data model

```mermaid
erDiagram
  Org ||--o{ Membership : has
  User ||--o{ Membership : has
  Org ||--o{ Installation : has
  Installation ||--o{ Repo : grants
  Org ||--o{ Repo : owns
  Repo ||--o{ PullRequest : has
  PullRequest ||--o{ Review : has
  Review ||--o{ Issue : has
  Org ||--o{ ProviderCredential : has
  User ||--o{ ProviderCredential : connects
```

Key fields:
- **Repo:** `provider`, `settings` (JSON, `RepoSettingsSchema`), `ingestTokenHash`, `active`
- **PullRequest:** `number`, `state`, `headSha`, `baseRef`, `additions`, `deletions`, `changedFiles`
- **Review:** `headSha`, `provider`, `status`, `errorCode`, `errorMessage`, `filesTotal`, `filesDone`,
  `riskScore`, `riskLevel`, `riskFactors`, `summary`, `githubReviewId`, timestamps.
  Unique: `[pullRequestId, headSha, provider]`
- **Issue:** `file`, `line`, `severity`, `category`, `title`, `explanation`, `suggestedFix`, `posted`
- **ProviderCredential:** `encryptedToken`, `encryptedRefreshToken`, `expiresAt`

Not stored: source code, patches, prompts, raw AI responses (log only sizes/ids).

## 7. Interfaces

### Public HTTP (apps/api)
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/webhooks/github` | HMAC `X-Hub-Signature-256` | Events: `installation`, `installation_repositories`, `pull_request`, `issue_comment` |
| POST | `/api/ingest/review` | `Bearer rit_…` (hashed lookup) | Body `ReviewResult` ≤ 1 MB; 202 / 400 / 401 / 409 / 413 |
| GET | `/health` | none | |

### Dashboard API (apps/web, session auth + org membership check)
| Method | Path |
|---|---|
| GET | `/api/repos` |
| GET | `/api/repos/:repoId/pulls?state=open\|closed\|all` → `PullListItem[]` |
| GET | `/api/repos/:repoId/pulls/:number` → PR + latest `ReviewDetail` |
| POST | `/api/reviews/:id/retry`, `/api/repos/:repoId/pulls/:number/rerun` (`{provider?}`) |
| GET/PUT | `/api/repos/:repoId/settings` |
| POST | `/api/repos/:repoId/ingest-token/rotate` → token shown once |
| POST | `/api/repos/:repoId/setup/workflow-pr` |
| GET | `/api/orgs/:orgId/overview?range=30d\|90d` |
| GET | `/api/oauth/chatgpt/start`, `/api/oauth/chatgpt/callback`; DELETE `/api/connections/chatgpt` |

### Queue (`reviews`)
| Job | Payload | Producer |
|---|---|---|
| `review.start` | `{ reviewId }` | api (webhook), web (retry/rerun) |
| `review.finalize` | `{ reviewId }` | worker, api (ingest) |
| `review.sweep` | — (repeatable, 5 min) | worker scheduler |

### Provider interface
`ReviewProvider.reviewChunk(ReviewChunkInput, ProviderContext) → ReviewChunkResult`;
throws `ProviderError(code)`. Defined in `packages/shared/provider.ts`.

## 8. Review pipeline details
1. **Filter:** removed/binary files, `ignorePaths`, secret-like files (`.env*`, `*.pem`, `*.key`), lockfiles.
2. **Context:** PR title/body, `CHANGE_NOTES.md`, `AGENTS.md` at head SHA.
3. **Chunk:** est. tokens = chars/4; pack ≤ 60k; oversize file → first hunks + note; total > 400k →
   prioritize sensitive paths, mark `too_large` warning.
4. **Call:** concurrency 3; 90s timeout; retries: timeout/rate_limited ×2, invalid_output ×1, auth ×0.
5. **Validate:** extract JSON, zod parse; drop issues not in diff.
6. **Score:** `computeRisk` (weights in `packages/scoring/src/weights.ts`):
   AI max × 0.4 + issue severity (cap 40) + size + sensitive paths + missing tests → 0–100.
7. **Post:** one GitHub review (`COMMENT`), ≤ 50 inline comments, `suggestion` blocks, escaped markdown,
   mentions neutralized; prior bot summary marked outdated.

## 9. Security
| Area | Control |
|---|---|
| Webhooks | HMAC SHA-256, timing-safe compare, delivery dedupe (Redis, 24h) |
| Ingest | Per-repo random token (`rit_`), stored as SHA-256 only, rotatable, rate-limited 30/h |
| User credentials | Claude/OpenAI keys for Actions never touch platform; ChatGPT tokens AES-256-GCM |
| Tenant isolation | Every dashboard query scoped by org membership |
| AI output | Untrusted: schema validation, length caps, markdown/HTML escaping, diff-line check |
| Data minimization | No code/patch/prompt storage; no secrets in logs |
| Transport | HTTPS only (Caddy, HSTS); internal services not exposed |
| Server | SSH keys only, UFW 22/80/443, unattended upgrades, fail2ban, non-root containers |
| GitHub App permissions | Pull requests R/W, Contents R, Checks R/W, Metadata R, Issues R |

## 10. Deployment

```
VPS (Ubuntu LTS)
└── docker compose (infra/compose.prod.yml)
    ├── caddy        :80/:443  → auto Let's Encrypt
    ├── web          :3000     (Next.js)
    ├── api          :4000     (Fastify)
    ├── worker       ×N        (BullMQ)
    ├── migrate      one-shot  (prisma migrate deploy)
    ├── postgres     volume
    └── redis        volume, AOF
```
- CI (`.github/workflows/ci.yml`): lint, typecheck, test, build on every PR.
- CD (`deploy.yml`): build → push GHCR (sha tags) → SSH → `compose pull && up -d` → healthcheck →
  rollback on failure.
- Backups: nightly `pg_dump`, 7 daily + 4 weekly, optional off-site S3.

## 11. Observability
- Structured logs (pino) with `reviewId`, `repoId`, `orgId`; rotated container logs.
- Health endpoints for uptime monitor; optional Sentry.
- Key metrics (from DB): reviews by status/provider, duration p50/p95, error code counts, queue depth.

## 12. Scaling path
| Stage | Change |
|---|---|
| Now | Single VPS, worker ×2–4 |
| More load | Scale `worker` replicas; move Postgres to managed DB |
| Bigger | Separate worker host(s); Redis managed; CDN for web |
| Enterprise | Per-tenant queues/rate limits; GitHub Enterprise Server support |

## 13. Key decisions
| # | Decision | Reason |
|---|---|---|
| D1 | One `ReviewResult` schema for all providers | Consistent scoring, comments, UI; providers swappable |
| D2 | Claude-plan reviews run in the user's Action, never on our servers | Anthropic restricts consumer-plan credentials to its own tools |
| D3 | Codex-plan reviews via Sign in with ChatGPT on our worker | Officially supported for third-party apps; zero setup for user |
| D4 | Our GitHub App posts comments (not the agent in the Action) | Same formatting and filtering for every provider |
| D5 | Fastify api separate from Next.js | Webhooks/ingest isolated from UI; independent scaling and limits |
| D6 | BullMQ + Redis | Simple, reliable retries/backoff; fits single VPS |
| D7 | Don't store code | Trust + lower compliance burden |
| D8 | Chunk per file group | Large PRs (100+ files) otherwise exceed context/timeouts |

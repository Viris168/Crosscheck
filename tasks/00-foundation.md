# Task 00 — Foundation

**Branch:** `feat/foundation` · **Runs alone, before all other lanes.**

## Goal
Create the monorepo skeleton and lock every shared contract so the lanes can build in parallel
without guessing. Don't build features.

Read first: `CLAUDE.md`, `docs/tech-stack.md`, `docs/essential-architecture.md`.

## You own
Root config files, `packages/shared`, `packages/db`, empty package skeletons for every other package,
the `apps/web` skeleton (see below), `docker-compose.dev.yml`, `.env.example`, `tasks/CONTRACT_REQUESTS.md`.
After merge you keep only: `packages/shared`, `packages/db`, root config, `apps/web/src/server/{auth,env,redis}.ts`,
`apps/web/src/app/api/{auth,inngest,health}/`. Everything else in `apps/web` passes to its lane.

## Build

### 1. Monorepo skeleton
- pnpm workspace + Turborepo (`build`, `dev`, `test`, `lint`, `typecheck` pipelines)
- `tsconfig.base.json` (strict), ESLint + Prettier, Vitest config
- Empty packages, each with `package.json`, `src/index.ts` (export nothing yet), and one passing placeholder test:
  `packages/github`, `packages/providers`, `packages/scoring`, `packages/github-comments`,
  `packages/workflow-templates`
- There is **no** `apps/api` and **no** `apps/worker`. Delete those folders if they exist.

### 2. `apps/web` skeleton (`@app/web`)
- Next.js (App Router, `src/` dir, TypeScript strict) + React + Tailwind + shadcn/ui init + TanStack Query
  provider in the root layout. Path alias `@/*` → `src/*`. Vitest set up for the app.
- Empty lane folders, each with an `index.ts` (exports nothing yet) and a placeholder test:
  `src/server/github/`, `src/server/ingest/`, `src/server/jobs/`.
- `src/server/env.ts`: zod-parsed env (all vars in `.env.example`), exported `env`.
- `src/server/redis.ts`: shared `ioredis` client (lazy singleton) from `REDIS_URL`.
- `src/server/auth.ts`: **Better Auth** with the Prisma adapter, GitHub social provider
  (`GITHUB_CLIENT_ID/SECRET`), and the **organization plugin** (roles owner|admin|member). Export `auth`
  and a helper `requireSession(req)` → `{ user, session }` or throws 401, and
  `requireOrgMember(userId, orgId, roles?)` → throws 403. Client in `src/lib/auth-client.ts`.
- `src/app/api/auth/[...all]/route.ts`: Better Auth handler.
- `src/server/jobs/client.ts`: `export const inngest = new Inngest({ id: 'ai-review', schemas })` using the
  event schemas from `@app/shared`. `src/server/jobs/index.ts` exports `inngest` and `functions` (empty array).
- `src/app/api/inngest/route.ts`: `serve({ client: inngest, functions })` from `@/server/jobs`.
- `src/app/api/health/route.ts`: `GET` → `{ ok: true }` 200.
- `src/app/api/webhooks/github/route.ts` and `src/app/api/ingest/review/route.ts`: `POST` → 501 stubs
  (lanes A and D replace them). Set `export const runtime = 'nodejs'` on both.
- A placeholder home page that shows "signed in as …" when logged in, so login can be tested.

### 3. `docker-compose.dev.yml`
- `postgres` 16 (volume; init script creating DBs `app` and `inngest`)
- `redis` 7
- `inngest`: `inngest/inngest` image running `inngest dev -u http://host.docker.internal:3000/api/inngest`
  on port 8288 (add `extra_hosts: host.docker.internal:host-gateway` for Linux).
  `// VERIFY:` exact dev-server command and flags against Inngest's current self-hosting docs.

### 4. `.env.example`
```
PUBLIC_URL=http://localhost:3000
DATABASE_URL=postgresql://app:app@localhost:5432/app
REDIS_URL=redis://localhost:6379
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
GITHUB_CLIENT_ID=            # GitHub App's OAuth client, used by Better Auth for login
GITHUB_CLIENT_SECRET=
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
INNGEST_BASE_URL=http://localhost:8288   # http://inngest:8288 in production compose
INNGEST_DEV=1                # dev only
ENCRYPTION_KEY=              # 32 bytes, base64
ANTHROPIC_API_KEY=           # platform default provider
OPENAI_API_KEY=              # optional platform fallback
CHATGPT_OAUTH_CLIENT_ID=     # Sign in with ChatGPT
CHATGPT_OAUTH_CLIENT_SECRET=
```

### 5. `packages/db` (Prisma)
Better Auth owns the auth tables. Generate them with the Better Auth CLI (Prisma adapter + organization
plugin), then add our fields:
- `User` (Better Auth) + `login`, `avatarUrl`. GitHub id comes from `Account` (`providerId = 'github'`).
- `Session`, `Account`, `Verification` (Better Auth, unchanged)
- `Organization` (Better Auth, our **Org**) + `githubAccountLogin`, `plan`
- `Member` (Better Auth, our **Membership**: userId, organizationId, role owner|admin|member) · `Invitation`
Our models (add indexes on foreign keys and `[repoId, number]`, `[pullRequestId, headSha]`):
- `Installation` (githubInstallationId, orgId → Organization)
- `Repo` (orgId, installationId, githubRepoId, fullName, provider `ProviderId`, settings Json,
  ingestTokenHash?, active)
- `PullRequest` (repoId, number, title, body, author, state open|closed|merged, headSha, baseRef, headRef,
  additions, deletions, changedFiles, updatedAt)
- `Review` (pullRequestId, headSha, provider, status `ReviewStatus`, errorCode `ErrorCode?`,
  errorMessage?, filesTotal, filesDone, riskScore?, riskLevel?, riskFactors Json?, summary?,
  githubReviewId?, createdAt, startedAt?, finishedAt?) · unique `[pullRequestId, headSha, provider]`
- `Issue` (reviewId, file, line, severity, category, title, explanation, suggestedFix?, posted bool,
  githubCommentId?)
- `ProviderCredential` (userId, orgId, provider, encryptedToken, encryptedRefreshToken?, expiresAt?)
Export a singleton `prisma` client from `src/index.ts`. Add `pnpm db:migrate` and a seed script with one
org (+ owner member), repo, PR, and one review in each status. Mark Better Auth schema assumptions `// VERIFY:`.

### 6. `packages/shared` — the contracts (copy exactly, extend only if needed)
```ts
// enums.ts
export const ProviderId = ['claude_action', 'codex_chatgpt', 'codex_action', 'platform'] as const;
export type ProviderId = typeof ProviderId[number];
export const ReviewStatus = ['queued', 'running', 'waiting_action', 'completed', 'failed'] as const;
export type ReviewStatus = typeof ReviewStatus[number];
export const ErrorCode = ['too_large', 'provider_auth', 'rate_limited', 'timeout',
  'action_missing', 'invalid_output', 'github_error', 'internal'] as const;
export type ErrorCode = typeof ErrorCode[number];
export const Severity = ['low', 'medium', 'high', 'critical'] as const;
export const Category = ['security', 'bug', 'performance', 'style', 'test'] as const;

// review-result.ts  (schema v1 — the ONE format every provider returns)
export const IssueSchema = z.object({
  file: z.string(), line: z.number().int().positive(),
  severity: z.enum(Severity), category: z.enum(Category),
  title: z.string().max(200), explanation: z.string().max(4000),
  suggested_fix: z.string().max(8000).optional(),
});
export const ReviewResultSchema = z.object({
  schema_version: z.literal(1),
  repo: z.string(), pr_number: z.number().int(), head_sha: z.string(),
  model: z.string().optional(),
  risk_score: z.number().min(0).max(100),
  summary: z.string().max(4000),
  issues: z.array(IssueSchema).max(200),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewIssue = z.infer<typeof IssueSchema>;

// provider.ts
export interface ReviewFile { path: string; status: 'added'|'modified'|'removed'|'renamed'; patch: string; }
export interface ReviewChunkInput {
  repo: string; prNumber: number; headSha: string; baseRef: string;
  title: string; body: string;            // PR description = intent
  intentNotes?: string;                   // CHANGE_NOTES.md / linked issue text, if found
  guidelines?: string;                    // AGENTS.md / repo review rules
  files: ReviewFile[];
  chunkIndex: number; chunkCount: number;
}
export interface ReviewChunkResult { risk_score: number; summary: string; issues: ReviewIssue[]; model?: string; }
export interface ProviderContext { orgId: string; userId?: string; }
export interface ReviewProvider {
  id: ProviderId;
  runsInWorker: boolean;                  // true = runs inside our Inngest functions; false for *_action providers
  reviewChunk(input: ReviewChunkInput, ctx: ProviderContext): Promise<ReviewChunkResult>;
}
export class ProviderError extends Error { constructor(public code: ErrorCode, msg: string) { super(msg); } }

// events.ts — Inngest event names + payload schemas (ids only, never code or tokens)
export const ReviewRequestedEvent = z.object({ reviewId: z.string(), orgId: z.string() }); // orgId = Inngest concurrency key
export const ReviewFinalizeEvent = z.object({ reviewId: z.string() });
export const events = {
  'review/requested': { data: ReviewRequestedEvent },
  'review/finalize': { data: ReviewFinalizeEvent },
} as const;
// Usable with Inngest's `EventSchemas().fromZod(events)` — VERIFY against current Inngest SDK.
// review-sweep is a cron function (every 5 min), no event.

// risk.ts
export const RiskLevel = ['low', 'medium', 'high', 'critical'] as const;
export const RiskFactorSchema = z.object({ key: z.string(), label: z.string(), points: z.number() });
export const RiskResultSchema = z.object({ score: z.number(), level: z.enum(RiskLevel), factors: z.array(RiskFactorSchema) });
export type RiskFactor = z.infer<typeof RiskFactorSchema>;
export type RiskResult = z.infer<typeof RiskResultSchema>;

// repo-settings.ts
export const RepoSettingsSchema = z.object({
  minSeverity: z.enum(Severity).default('medium'),
  ignorePaths: z.array(z.string()).default(['dist/**', '**/*.lock', 'pnpm-lock.yaml', 'package-lock.json']),
  maxIssuesPerPr: z.number().int().default(30),
  language: z.string().default('en'),
  trigger: z.enum(['every_push', 'on_command']).default('every_push'),
  model: z.string().optional(),
});

// api/errors.ts — every non-2xx response
export const ApiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

// api/<area>.ts — request + response zod schemas for EVERY endpoint in docs/tech-stack.md.
// Name them <Action><Thing>Request / <Action><Thing>Response. At minimum:
//   api/repos.ts     ListReposResponse, GetRepoSettingsResponse, PutRepoSettingsRequest/Response,
//                    RotateIngestTokenResponse ({ token } — shown once), WorkflowPrRequest/Response
//   api/pulls.ts     ListPullsQuery ({ state: open|closed|all }), PullListItemSchema, ListPullsResponse,
//                    GetPullResponse (PR header + latest ReviewDetail + changed files), RerunRequest ({ provider? })
//   api/reviews.ts   ReviewDetailSchema, RetryReviewResponse
//   api/orgs.ts      OverviewQuery ({ range: 30d|90d }), OverviewResponse
//   api/ingest.ts    IngestRequest (ReviewResultSchema | { error: 'no_output' }), IngestResponse
// Shapes (as zod):
//   PullListItem { id, number, title, author, state: open|closed|merged, additions, deletions, changedFiles,
//     latestReview?: { status, riskScore?, riskLevel?, stale } }
//   ReviewDetail { id, status, provider, headSha, stale, errorCode?, errorMessage?, filesTotal, filesDone,
//     risk?: RiskResult, summary?, issues: (ReviewIssue & { id, posted })[], createdAt, finishedAt? }

// crypto.ts
export function encrypt(plain: string): string;      // AES-256-GCM with ENCRYPTION_KEY
export function decrypt(cipher: string): string;
export function generateIngestToken(): string;        // 'rit_' + 32 random bytes base64url
export function hashToken(token: string): string;     // sha256 hex
export function safeEqual(a: string, b: string): boolean;
```
Unit-test every schema and crypto function.

## Done when
- [ ] `pnpm install && pnpm turbo build test lint typecheck` passes on a clean clone
- [ ] `docker compose -f docker-compose.dev.yml up -d && pnpm db:migrate && pnpm db:seed` works
- [ ] `pnpm dev` → `GET /api/health` returns 200; Inngest dev UI at :8288 discovers the app (0 functions)
- [ ] GitHub login via Better Auth works locally (with a real GitHub OAuth app) and creates a `User`
- [ ] Every package and lane folder listed above exists with a placeholder test
- [ ] Contracts above are exported from `@app/shared`
- [ ] `tasks/CONTRACT_REQUESTS.md` exists (empty template)
- [ ] PR description lists every `// VERIFY:` assumption

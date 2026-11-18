# Task 00 — Foundation

**Branch:** `feat/foundation` · **Runs alone, before all other lanes.**

## Goal
Create the monorepo skeleton and lock every shared contract so seven agents can build in parallel
without guessing.

## You own
Root config files, `packages/shared`, `packages/db`, `apps/api/src/server.ts`, empty package skeletons
for every other package/app, `docker-compose.dev.yml`, `.env.example`, `tasks/CONTRACT_REQUESTS.md`.

## Build

### 1. Monorepo skeleton
- pnpm workspace + Turborepo (`build`, `dev`, `test`, `lint`, `typecheck` pipelines)
- `tsconfig.base.json` (strict), ESLint + Prettier, Vitest config
- Empty packages, each with `package.json`, `src/index.ts` (export nothing yet), and one passing placeholder test:
  `apps/web` (Next.js init), `apps/api`, `apps/worker`, `packages/github`, `packages/providers`,
  `packages/scoring`, `packages/github-comments`, `packages/workflow-templates`
- `apps/api/src/server.ts`: Fastify bootstrap that registers two plugins if present:
  `./github/plugin.ts` at `/api/webhooks/github` and `./ingest/plugin.ts` at `/api/ingest`.
  Create both plugin files as stubs returning 501 (lanes A and D will replace them). Add `GET /health`.
- `docker-compose.dev.yml`: postgres 16, redis 7
- `.env.example`:
  ```
  PUBLIC_URL=http://localhost:3000
  DATABASE_URL=postgresql://app:app@localhost:5432/app
  REDIS_URL=redis://localhost:6379
  GITHUB_APP_ID=
  GITHUB_APP_PRIVATE_KEY=
  GITHUB_WEBHOOK_SECRET=
  GITHUB_CLIENT_ID=
  GITHUB_CLIENT_SECRET=
  AUTH_SECRET=
  ENCRYPTION_KEY=            # 32 bytes, base64
  ANTHROPIC_API_KEY=         # platform default provider
  OPENAI_API_KEY=            # optional platform fallback
  CHATGPT_OAUTH_CLIENT_ID=   # Sign in with ChatGPT
  CHATGPT_OAUTH_CLIENT_SECRET=
  ```

### 2. `packages/db` (Prisma)
Models (add indexes on foreign keys and `[repoId, number]`, `[pullRequestId, headSha]`):
- `User` (githubId, login, avatarUrl)
- `Org` (name, githubAccountLogin, plan) · `Membership` (userId, orgId, role: owner|admin|member)
- `Installation` (githubInstallationId, orgId)
- `Repo` (orgId, installationId, githubRepoId, fullName, provider `ProviderId`, settings Json,
  ingestTokenHash?, active)
- `PullRequest` (repoId, number, title, body, author, state open|closed|merged, headSha, baseRef, headRef,
  additions, deletions, changedFiles, updatedAt)
- `Review` (pullRequestId, headSha, provider, status `ReviewStatus`, errorCode `ErrorCode?`,
  errorMessage?, filesTotal, filesDone, riskScore?, riskLevel?, riskFactors Json?, summary?,
  githubReviewId?, createdAt, startedAt?, finishedAt?)
- `Issue` (reviewId, file, line, severity, category, title, explanation, suggestedFix?, posted bool,
  githubCommentId?)
- `ProviderCredential` (userId, orgId, provider, encryptedToken, encryptedRefreshToken?, expiresAt?)
Export a singleton `prisma` client from `src/index.ts`. Add `pnpm db:migrate` and a seed script with one
org, repo, PR, and one review in each status.

### 3. `packages/shared` — the contracts (copy exactly, extend only if needed)
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
  runsInWorker: boolean;                  // false for *_action providers
  reviewChunk(input: ReviewChunkInput, ctx: ProviderContext): Promise<ReviewChunkResult>;
}
export class ProviderError extends Error { constructor(public code: ErrorCode, msg: string) { super(msg); } }

// jobs.ts
export const QUEUE = 'reviews';
export type JobName = 'review.start' | 'review.finalize' | 'review.sweep';
export interface ReviewStartJob { reviewId: string; }
export interface ReviewFinalizeJob { reviewId: string; }
// review.sweep: repeatable, no payload

// risk.ts
export interface RiskFactor { key: string; label: string; points: number; }
export interface RiskResult { score: number; level: 'low'|'medium'|'high'|'critical'; factors: RiskFactor[]; }

// repo-settings.ts
export const RepoSettingsSchema = z.object({
  minSeverity: z.enum(Severity).default('medium'),
  ignorePaths: z.array(z.string()).default(['dist/**', '**/*.lock', 'pnpm-lock.yaml', 'package-lock.json']),
  maxIssuesPerPr: z.number().int().default(30),
  language: z.string().default('en'),
  trigger: z.enum(['every_push', 'on_command']).default('every_push'),
  model: z.string().optional(),
});

// api.ts — dashboard response shapes used by apps/web
export interface PullListItem { id: string; number: number; title: string; author: string;
  state: 'open'|'closed'|'merged'; additions: number; deletions: number; changedFiles: number;
  latestReview?: { status: ReviewStatus; riskScore?: number; riskLevel?: RiskResult['level']; stale: boolean }; }
export interface ReviewDetail { id: string; status: ReviewStatus; provider: ProviderId; headSha: string;
  stale: boolean; errorCode?: ErrorCode; errorMessage?: string; filesTotal: number; filesDone: number;
  risk?: RiskResult; summary?: string; issues: (ReviewIssue & { id: string; posted: boolean })[];
  createdAt: string; finishedAt?: string; }

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
- [ ] `GET /health` on apps/api returns 200
- [ ] Every package listed above exists with a placeholder test
- [ ] Contracts above are exported from `@app/shared`
- [ ] `tasks/CONTRACT_REQUESTS.md` exists (empty template)

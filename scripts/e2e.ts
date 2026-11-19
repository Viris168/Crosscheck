/**
 * End-to-end check of the review pipeline against a REAL GitHub repo and the local dev stack.
 *
 *   pnpm e2e --repo owner/name [--provider platform|claude_action] [--timeout 900] [--keep]
 *
 * Needs (see docs in tasks/INTEGRATION.md → "Running the e2e script"):
 *   - docker compose -f docker-compose.dev.yml up -d, pnpm db:migrate, pnpm dev (APP_URL, default :3000)
 *   - the GitHub App installed on --repo, webhooks forwarded to /api/webhooks/github (smee)
 *   - .env with GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY, DATABASE_URL, BETTER_AUTH_SECRET, and
 *     ANTHROPIC_API_KEY (platform) — or, for claude_action, the workflow merged on the default branch,
 *     repo secrets CLAUDE_CODE_OAUTH_TOKEN + PLATFORM_INGEST_TOKEN, and PUBLIC_URL reachable from
 *     GitHub Actions (a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000`).
 *
 * Steps: preflight → repo registered by the installation webhook → set provider → open a PR with a
 * deliberately buggy file → wait for the Review row to finish → GitHub review + inline comments exist →
 * dashboard API shows completed + risk score → Inngest dev server shows completed runs → cleanup.
 *
 * Dev databases only: it creates a short-lived Better Auth session (and, if the org has no members yet,
 * an `e2e_` user + member) to call the dashboard API. Never run against production.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { prisma } from '@app/db';
import { getInstallationOctokit, splitFullName, type Octokit } from '@app/github';
import { GetPullResponse, GetRepoSettingsResponse, ReviewDetailSchema } from '@app/shared';

// ---------------------------------------------------------------- args + env

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string', default: process.env.E2E_REPO },
    provider: { type: 'string', default: 'platform' },
    timeout: { type: 'string', default: '900' },
    keep: { type: 'boolean', default: false },
  },
});

const APP_URL = (process.env.E2E_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const INNGEST_URL = (process.env.INNGEST_BASE_URL ?? 'http://localhost:8288').replace(/\/$/, '');
const PROVIDER = args.provider as 'platform' | 'claude_action';
const TIMEOUT_MS = Number(args.timeout) * 1000;
const WORKFLOW_PATH = '.github/workflows/ai-review.yml';
// VERIFY: Better Auth session cookie over http (no __Secure- prefix), same as apps/web/e2e/session.ts.
const SESSION_COOKIE = 'better-auth.session_token';

// ---------------------------------------------------------------- tiny test harness

const results: { step: string; ok: boolean; detail?: string }[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

class StepFailed extends Error {}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`… ${name}\n`);
  try {
    const out = await fn();
    results.push({ step: name, ok: true });
    process.stdout.write(`✓ ${name}\n`);
    return out;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: name, ok: false, detail });
    process.stdout.write(`✗ ${name}\n    ${detail}\n`);
    throw new StepFailed(name);
  }
}

/** A check that only warns (e.g. depends on an unverified API). */
async function softStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await step(name, fn);
  } catch {
    results[results.length - 1]!.ok = true;
    results[results.length - 1]!.detail = `WARN: ${results[results.length - 1]!.detail}`;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const log = (...parts: unknown[]) => process.stdout.write(`${parts.join(' ')}\n`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(
  what: string,
  fn: () => Promise<T | undefined | null>,
  timeoutMs = TIMEOUT_MS,
  everyMs = 3000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > until)
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- dashboard session (dev only)

async function dashboardCookie(orgId: string): Promise<string> {
  const secret = process.env.BETTER_AUTH_SECRET;
  assert(secret, 'BETTER_AUTH_SECRET is not set');
  let member = await prisma.member.findFirst({ where: { organizationId: orgId } });
  if (!member) {
    const id = `e2e_${randomBytes(6).toString('hex')}`;
    await prisma.user.create({ data: { id, name: 'e2e', email: `${id}@e2e.invalid` } });
    member = await prisma.member.create({
      data: { id, organizationId: orgId, userId: id, role: 'owner' },
    });
    cleanups.push(() => prisma.user.delete({ where: { id } }));
  }
  const token = randomBytes(24).toString('base64url');
  const sessionId = `e2e_${token.slice(0, 12)}`;
  await prisma.session.create({
    data: {
      id: sessionId,
      token,
      userId: member.userId,
      activeOrganizationId: orgId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  cleanups.push(() => prisma.session.deleteMany({ where: { id: sessionId } }));
  // VERIFY: better-call signed cookie = `${token}.${base64(HMAC-SHA256(secret, token))}`.
  const sig = createHmac('sha256', secret).update(token).digest('base64');
  return `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${sig}`)}`;
}

async function api(cookie: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${APP_URL}${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', origin: APP_URL, ...init.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------- the PR we open

// Deliberately flawed so every reviewer has something to say (SQL injection, missing null check).
const BUGGY_FILE = `import type { Db } from './db';

export async function findUser(db: Db, id: string) {
  const rows = await db.raw(\`SELECT * FROM users WHERE id = '\${id}'\`);
  return rows[0].email.toLowerCase();
}

export function average(xs: number[]): number {
  let sum = 0;
  for (let i = 0; i <= xs.length; i++) sum += xs[i];
  return sum / xs.length;
}
`;

async function openTestPr(octokit: Octokit, fullName: string) {
  const { owner, repo } = splitFullName(fullName);
  const { data: info } = await octokit.rest.repos.get({ owner, repo });
  const base = info.default_branch;
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `e2e/${stamp}`;
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: ref.object.sha,
  });
  cleanups.push(() =>
    octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }).catch(() => undefined),
  );
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch,
    path: `src/e2e-${stamp}.ts`,
    message: 'test: e2e sample change',
    content: Buffer.from(BUGGY_FILE).toString('base64'),
  });
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    base,
    head: branch,
    title: `e2e (${PROVIDER}) ${stamp}`,
    body: 'Opened by `scripts/e2e.ts`. Safe to close.',
  });
  cleanups.push(() =>
    octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' }),
  );
  return { number: pr.number, headSha: pr.head.sha, url: pr.html_url, base };
}

// ---------------------------------------------------------------- Inngest dev server

interface InngestEvent {
  id?: string;
  internal_id?: string;
  name: string;
  data: Record<string, unknown>;
}
interface InngestRun {
  run_id: string;
  status: string;
  function_id?: string;
}

// VERIFY: the Inngest dev server serves the REST API v1 (`GET /v1/events?name=`, `GET
// /v1/events/:id/runs`) without auth, like Inngest Cloud's api.inngest.com/v1.
async function inngestRuns(eventName: string, reviewId: string): Promise<InngestRun[]> {
  const res = await fetch(`${INNGEST_URL}/v1/events?name=${encodeURIComponent(eventName)}`);
  assert(res.ok, `GET /v1/events → ${res.status}`);
  const { data: events } = (await res.json()) as { data: InngestEvent[] };
  const ev = events.find((e) => e.data?.reviewId === reviewId);
  assert(ev, `no ${eventName} event with reviewId ${reviewId}`);
  const id = ev.internal_id ?? ev.id;
  const runsRes = await fetch(`${INNGEST_URL}/v1/events/${id}/runs`);
  assert(runsRes.ok, `GET /v1/events/${id}/runs → ${runsRes.status}`);
  return ((await runsRes.json()) as { data: InngestRun[] }).data;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  assert(args.repo, 'pass --repo owner/name (or set E2E_REPO)');
  assert(
    PROVIDER === 'platform' || PROVIDER === 'claude_action',
    '--provider must be platform|claude_action',
  );
  const fullName = args.repo;
  log(`e2e: ${fullName} via ${PROVIDER} against ${APP_URL}\n`);

  await step('preflight: env, app /api/health, Inngest dev server', async () => {
    for (const k of [
      'DATABASE_URL',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'BETTER_AUTH_SECRET',
    ]) {
      assert(process.env[k], `${k} is not set in .env`);
    }
    if (PROVIDER === 'platform')
      assert(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY is not set');
    const health = await fetch(`${APP_URL}/api/health`).catch(() => null);
    assert(health?.ok, `${APP_URL}/api/health is not OK — is \`pnpm dev\` running?`);
    const ing = await fetch(`${INNGEST_URL}/health`).catch(() => null);
    assert(ing?.ok, `${INNGEST_URL}/health is not OK — is the inngest container up?`);
  });

  const repo = await step(
    'GitHub App installed: repo registered by the installation webhook',
    async () => {
      const r = await prisma.repo.findFirst({
        where: { fullName: { equals: fullName, mode: 'insensitive' }, active: true },
        include: { installation: true },
      });
      assert(
        r,
        `no active Repo row for ${fullName}. Install the GitHub App on it and check that smee forwards ` +
          'to /api/webhooks/github (the installation webhook creates the row).',
      );
      return r;
    },
  );

  const octokit = await step('installation token', () =>
    getInstallationOctokit(repo.installation.githubInstallationId),
  );
  const cookie = await step('dashboard session (dev)', () => dashboardCookie(repo.orgId));

  await step(`repo provider = ${PROVIDER} (PUT /api/repos/:id/settings)`, async () => {
    const current = GetRepoSettingsResponse.parse(
      await api(cookie, `/api/repos/${repo.id}/settings`),
    );
    if (current.provider === PROVIDER) return;
    await api(cookie, `/api/repos/${repo.id}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ provider: PROVIDER, settings: current.settings }),
    });
    if (!args.keep) {
      cleanups.push(() =>
        api(cookie, `/api/repos/${repo.id}/settings`, {
          method: 'PUT',
          body: JSON.stringify({ provider: current.provider, settings: current.settings }),
        }),
      );
    }
  });

  if (PROVIDER === 'claude_action') {
    await step(`${WORKFLOW_PATH} is on the default branch`, async () => {
      const { owner, repo: name } = splitFullName(fullName);
      const { data: info } = await octokit.rest.repos.get({ owner, repo: name });
      const found = await octokit.rest.repos
        .getContent({ owner, repo: name, path: WORKFLOW_PATH, ref: info.default_branch })
        .then(() => true)
        .catch(() => false);
      assert(
        found,
        `${WORKFLOW_PATH} missing. Use the setup wizard (or POST /api/repos/${repo.id}/setup/workflow-pr), ` +
          'merge the PR, and add the CLAUDE_CODE_OAUTH_TOKEN + PLATFORM_INGEST_TOKEN repo secrets.',
      );
    });
  }

  const pr = await step('open a PR', () => openTestPr(octokit, fullName));
  log(`    ${pr.url}`);

  const reviewId = await step('pull_request webhook → Review row created', () =>
    poll(
      'the Review row',
      async () =>
        (
          await prisma.review.findFirst({
            where: { pullRequest: { repoId: repo.id, number: pr.number }, headSha: pr.headSha },
            select: { id: true },
          })
        )?.id,
      120_000,
    ),
  );
  log(`    reviewId ${reviewId}`);

  const review = await step(`review finishes (${PROVIDER})`, async () => {
    const seen = new Set<string>();
    const r = await poll('a terminal review status', async () => {
      const row = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
        include: { issues: true },
      });
      if (!seen.has(row.status)) {
        seen.add(row.status);
        log(`    status: ${row.status}`);
      }
      return ['completed', 'failed', 'cancelled'].includes(row.status) ? row : null;
    });
    assert(
      r.status === 'completed',
      `review ${r.status}: ${r.errorCode ?? ''} ${r.errorMessage ?? ''}`.trim(),
    );
    assert(r.riskScore !== null && r.riskLevel !== null, 'completed review has no risk score');
    assert(r.githubReviewId !== null, 'completed review has no githubReviewId');
    if (PROVIDER === 'claude_action')
      assert(seen.has('waiting_action'), 'never went through waiting_action');
    return r;
  });
  log(
    `    risk ${review.riskScore} (${review.riskLevel}), ${review.issues.length} issues, ` +
      `${review.issues.filter((i) => i.posted).length} posted inline`,
  );

  await step('GitHub: review + inline comments on the PR', async () => {
    const { owner, repo: name } = splitFullName(fullName);
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo: name,
      pull_number: pr.number,
    });
    const gh = reviews.find((r) => BigInt(r.id) === review.githubReviewId);
    assert(gh, `GitHub review ${review.githubReviewId} not found on the PR`);
    assert(gh.user?.type === 'Bot', `review author is ${gh.user?.login}, expected the App bot`);
    const { data: comments } = await octokit.rest.pulls.listCommentsForReview({
      owner,
      repo: name,
      pull_number: pr.number,
      review_id: gh.id,
    });
    const posted = review.issues.filter((i) => i.posted).length;
    assert(
      comments.length === posted,
      `${comments.length} inline comments on GitHub, ${posted} issues marked posted`,
    );
    assert(posted > 0, 'no inline comments were posted (the sample file has obvious bugs)');
  });

  await step('dashboard API: completed + risk score', async () => {
    const pull = GetPullResponse.parse(
      await api(cookie, `/api/repos/${repo.id}/pulls/${pr.number}`),
    );
    assert(
      pull.review?.id === reviewId,
      `latest review is ${pull.review?.id}, expected ${reviewId}`,
    );
    assert(pull.review.status === 'completed', `dashboard status ${pull.review.status}`);
    assert(
      pull.review.risk?.score === review.riskScore,
      'dashboard risk score differs from the DB',
    );
    assert(pull.files.length > 0, 'no changed files (live GitHub fetch)');
    const detail = ReviewDetailSchema.parse(await api(cookie, `/api/reviews/${reviewId}`));
    assert(detail.status === 'completed', `GET /api/reviews/:id status ${detail.status}`);
  });

  await softStep('Inngest dev server: review-start + review-finalize runs completed', async () => {
    if (PROVIDER === 'platform') {
      const runs = await inngestRuns('review/requested', reviewId);
      assert(
        runs.some((r) => /complete/i.test(r.status)),
        `review/requested runs: ${JSON.stringify(runs)}`,
      );
    }
    const fin = await inngestRuns('review/finalize', reviewId);
    assert(
      fin.some((r) => /complete/i.test(r.status)),
      `review/finalize runs: ${JSON.stringify(fin)}`,
    );
  });
}

// ---------------------------------------------------------------- run

async function run(): Promise<never> {
  let failed = false;
  try {
    await main();
  } catch (err) {
    failed = true;
    if (!(err instanceof StepFailed)) console.error(err instanceof Error ? err.message : err);
  } finally {
    if (!args.keep) {
      for (const c of cleanups.reverse()) await c().catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  log('\nSummary');
  for (const r of results)
    log(`  ${r.ok ? '✓' : '✗'} ${r.step}${r.detail ? ` — ${r.detail}` : ''}`);
  if (args.keep) log('  (--keep: PR, branch and provider setting left in place)');
  process.exit(failed ? 1 : 0);
}

void run();

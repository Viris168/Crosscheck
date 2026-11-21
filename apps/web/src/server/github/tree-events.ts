import 'server-only';
import { prisma } from '@app/db';
import { ciBucket, type CiBucket } from '@app/github';
import { inngest } from '@/server/jobs';
import { logger } from '@/server/logger';
import type { HandlerResult } from './handlers';
import {
  CheckRunPayload,
  CheckSuitePayload,
  PullRequestTreePayload,
  PushPayload,
  StatusPayload,
} from './payloads';

// Branch-tree webhooks (T5a). Each handler records one `GitEvent` (refs and SHAs only; the
// delivery id makes it idempotent) and sends `tree/refs-changed` with ids only. Fetching and
// snapshot updates happen in the `tree-refresh` job (T5b).
//
// `GitEvent` field meanings, for T5b:
// - `ref`: the short branch name (`feat/x`, like `Branch.name` / `PullRequest.headRef`); null for `ci`.
// - `before` / `after`: SHAs as GitHub sent them, except the all-zero SHA is stored as null
//   (`branch_created` → `before` null, `branch_deleted` → `after` null).
// - `ci`: `after` = the commit the check run / suite / status is for.
// - `pull_request`: `after` = the PR head SHA, `prNumber` set.

/** Per-delivery context the webhook route passes to handlers. */
export interface WebhookContext {
  deliveryId: string;
}

export type GitEventKind =
  'push' | 'branch_created' | 'branch_deleted' | 'force_push' | 'pull_request' | 'ci';

const ignored = (note: string): HandlerResult => ({ handled: false, note });

const ZERO_SHA = /^0+$/;
const shaOrNull = (sha: string | null | undefined) => (!sha || ZERO_SHA.test(sha) ? null : sha);

const BRANCH_PREFIX = 'refs/heads/';

interface TreeRepo {
  id: string;
  orgId: string;
}

async function findTreeRepo(githubRepoId: number): Promise<TreeRepo | null> {
  const repo = await prisma.repo.findUnique({
    where: { githubRepoId },
    select: { id: true, orgId: true, active: true },
  });
  return repo && repo.active ? { id: repo.id, orgId: repo.orgId } : null;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'P2002';
}

interface GitEventInput {
  kind: GitEventKind;
  ref?: string | null;
  before?: string | null;
  after?: string | null;
  prNumber?: number | null;
}

/**
 * Inserts the `GitEvent` for this delivery. A repeated delivery id (Redis dedupe was down, or the
 * first attempt failed after the insert) returns the existing row instead of a second one.
 */
async function recordGitEvent(
  repoId: string,
  ctx: WebhookContext,
  input: GitEventInput,
): Promise<{ id: string; duplicate: boolean }> {
  try {
    const row = await prisma.gitEvent.create({
      data: {
        repoId,
        deliveryId: ctx.deliveryId,
        kind: input.kind,
        ref: input.ref ?? null,
        before: shaOrNull(input.before),
        after: shaOrNull(input.after),
        prNumber: input.prNumber ?? null,
      },
      select: { id: true },
    });
    return { id: row.id, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await prisma.gitEvent.findUnique({
      where: { deliveryId: ctx.deliveryId },
      select: { id: true },
    });
    if (!existing) throw err;
    return { id: existing.id, duplicate: true };
  }
}

/**
 * Sends `tree/refs-changed`. Sent again for a duplicate delivery (the first attempt may have failed
 * at this step); the event id lets Inngest drop the repeat.
 */
async function sendRefsChanged(repo: TreeRepo, eventId: string): Promise<void> {
  // VERIFY: Inngest v3 `id` on `send` deduplicates events with the same id for 24 h.
  await inngest.send({
    id: `tree-refs-changed-${eventId}`,
    name: 'tree/refs-changed',
    data: { repoId: repo.id, orgId: repo.orgId, eventId },
  });
}

async function recordAndSend(
  repo: TreeRepo,
  ctx: WebhookContext,
  input: GitEventInput,
  beforeSend?: () => Promise<void>,
): Promise<HandlerResult> {
  const event = await recordGitEvent(repo.id, ctx, input);
  await beforeSend?.();
  await sendRefsChanged(repo, event.id);
  return {
    handled: true,
    note: event.duplicate ? `${input.kind} (already recorded)` : input.kind,
  };
}

// ---------------------------------------------------------------- push

function pushKind(p: PushPayload): GitEventKind {
  if (p.deleted) return 'branch_deleted';
  if (p.created) return 'branch_created';
  if (p.forced) return 'force_push';
  return 'push';
}

/** `push`: branch created / deleted / force-pushed / pushed. Tag and other non-branch refs are ignored. */
export async function handlePush(body: unknown, ctx: WebhookContext): Promise<HandlerResult> {
  const p = PushPayload.parse(body);
  if (!p.ref.startsWith(BRANCH_PREFIX)) {
    return ignored(p.ref.startsWith('refs/tags/') ? 'tag push' : 'not a branch ref');
  }
  const branch = p.ref.slice(BRANCH_PREFIX.length);
  if (!branch) return ignored('not a branch ref');

  const repo = await findTreeRepo(p.repository.id);
  if (!repo) return ignored('repo not installed or inactive');

  return recordAndSend(repo, ctx, {
    kind: pushKind(p),
    ref: branch,
    before: p.before,
    after: p.after,
  });
}

// ---------------------------------------------------------------- pull_request

/** Actions that change what the tree shows: PR head, state or base. */
const PR_TREE_ACTIONS = new Set(['opened', 'reopened', 'closed', 'synchronize', 'edited']);

/**
 * `pull_request` → `GitEvent` kind `pull_request`. Runs next to the review handler, which keeps
 * doing the PR upsert and review; this only records and sends `tree/refs-changed`.
 */
export async function recordPullRequestEvent(
  body: unknown,
  ctx: WebhookContext,
): Promise<HandlerResult> {
  const p = PullRequestTreePayload.parse(body);
  if (!PR_TREE_ACTIONS.has(p.action)) return ignored(`pull_request.${p.action}`);
  if (p.action === 'edited' && p.changes?.base === undefined)
    return ignored('edited, base unchanged');

  const repo = await findTreeRepo(p.repository.id);
  if (!repo) return ignored('repo not installed or inactive');

  return recordAndSend(repo, ctx, {
    kind: 'pull_request',
    ref: p.pull_request.head.ref,
    after: p.pull_request.head.sha,
    prNumber: p.pull_request.number,
  });
}

// ---------------------------------------------------------------- CI

/**
 * One payload is one check run / suite / status, not the whole picture, so the row written here is
 * provisional: a failure is a failure (any failure fails the commit; a re-run or a newer status sends
 * another event), anything else is written as `pending`, which is not terminal, so the next sync
 * fetches the real combined state (`fetchCiState`). Existing counts are kept; a new row gets the
 * payload's bucket counted once.
 */
async function upsertProvisionalCi(repoId: string, sha: string, bucket: CiBucket): Promise<void> {
  const state = bucket === 'failure' ? 'failure' : 'pending';
  const counts: Record<CiBucket, number> = { success: 0, failure: 0, pending: 0, neutral: 0 };
  counts[bucket] = 1;
  await prisma.commitCi.upsert({
    where: { repoId_sha: { repoId, sha } },
    create: { repoId, sha, state, counts },
    update: { state },
  });
}

async function isBranchHead(repoId: string, sha: string): Promise<boolean> {
  const hit = await prisma.branch.findFirst({
    where: { repoId, headSha: sha, deletedAt: null },
    select: { id: true },
  });
  return !!hit;
}

async function handleCi(
  githubRepoId: number,
  sha: string,
  bucket: CiBucket,
  ctx: WebhookContext,
): Promise<HandlerResult> {
  const repo = await findTreeRepo(githubRepoId);
  if (!repo) return ignored('repo not installed or inactive');
  // The tree shows CI on branch heads only. A head the sync has not seen yet gets its CI from
  // the sync's own fetch.
  if (!(await isBranchHead(repo.id, sha))) return ignored('not a branch head');

  return recordAndSend(repo, ctx, { kind: 'ci', after: sha }, () =>
    upsertProvisionalCi(repo.id, sha, bucket),
  );
}

const checkBucket = (c: { status?: string | null; conclusion?: string | null }) =>
  ciBucket(c.status === 'completed' ? c.conclusion : c.status);

export async function handleCheckRun(body: unknown, ctx: WebhookContext): Promise<HandlerResult> {
  const p = CheckRunPayload.parse(body);
  return handleCi(p.repository.id, p.check_run.head_sha, checkBucket(p.check_run), ctx);
}

export async function handleCheckSuite(body: unknown, ctx: WebhookContext): Promise<HandlerResult> {
  const p = CheckSuitePayload.parse(body);
  return handleCi(p.repository.id, p.check_suite.head_sha, checkBucket(p.check_suite), ctx);
}

export async function handleStatus(body: unknown, ctx: WebhookContext): Promise<HandlerResult> {
  const p = StatusPayload.parse(body);
  return handleCi(p.repository.id, p.sha, ciBucket(p.state), ctx);
}

/**
 * The `pull_request` entry for the webhook HANDLERS map: the review handler first (unchanged),
 * then the tree event. A tree failure is logged and does not change the review response; the
 * 15-minute tree cron (T5b) catches up.
 */
export function withTreeEvent(
  review: (body: unknown) => Promise<HandlerResult>,
): (body: unknown, ctx: WebhookContext) => Promise<HandlerResult & { tree?: string }> {
  return async (body, ctx) => {
    const result = await review(body);
    try {
      const tree = await recordPullRequestEvent(body, ctx);
      return tree.handled ? { ...result, tree: tree.note } : result;
    } catch (err) {
      logger.warn(
        { deliveryId: ctx.deliveryId, err: (err as Error).message },
        'pull_request tree event failed',
      );
      return result;
    }
  };
}

import 'server-only';
import { prisma } from '@app/db';
import {
  ACTION_PROVIDERS,
  HttpError,
  INGEST_TOKEN_PREFIX,
  IngestRequest,
  LIMITS,
  errorResponse,
  hashToken,
  isActionProvider,
  safeEqual,
  type ProviderId,
  type ReviewResult,
} from '@app/shared';
import { requestReview } from '@/server/github';
import { inngest } from '@/server/jobs';
import { logger } from '@/server/logger';
import { readBodyWithLimit } from './body';
import { allowIngest } from './rate-limit';

type IngestedRepo = {
  id: string;
  orgId: string;
  fullName: string;
  provider: ProviderId;
  active: boolean;
  ingestTokenHash: string | null;
};

type ReviewRow = {
  id: string;
  provider: ProviderId;
  status: string;
  errorCode: string | null;
  startedAt: Date | null;
};

const REVIEW_SELECT = {
  id: true,
  provider: true,
  status: true,
  errorCode: true,
  startedAt: true,
} as const;

function json(body: { reviewId: string; duplicate: boolean }, status: number): Response {
  return Response.json(body, { status });
}

/** `Authorization: Bearer rit_…` → the repo that owns the token, or 401. */
async function authenticate(req: Request): Promise<{ repo: IngestedRepo; tokenHash: string }> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token || !token.startsWith(INGEST_TOKEN_PREFIX)) {
    throw new HttpError('unauthorized', 'Missing or invalid ingest token');
  }
  const tokenHash = hashToken(token);
  const repo = await prisma.repo.findUnique({
    where: { ingestTokenHash: tokenHash },
    select: {
      id: true,
      orgId: true,
      fullName: true,
      provider: true,
      active: true,
      ingestTokenHash: true,
    },
  });
  // The lookup is by hash (an index lookup reveals nothing useful about the token); the compare
  // below is constant-time defence in depth.
  if (!repo?.ingestTokenHash || !safeEqual(repo.ingestTokenHash, tokenHash) || !repo.active) {
    throw new HttpError('unauthorized', 'Missing or invalid ingest token');
  }
  return { repo, tokenHash };
}

async function parseBody(req: Request): Promise<IngestRequest> {
  const text = await readBodyWithLimit(req, LIMITS.maxIngestBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError('bad_request', 'Body is not valid JSON');
  }
  return IngestRequest.parse(raw); // ZodError → 400 via errorResponse
}

/** The Action review for `[pr, headSha]`, creating it if the PR's current head matches. */
async function findOrCreateReview(
  repo: IngestedRepo,
  pr: { id: string; headSha: string },
  headSha: string,
): Promise<ReviewRow> {
  const find = () =>
    prisma.review.findMany({
      where: {
        pullRequestId: pr.id,
        headSha,
        provider: { in: [...ACTION_PROVIDERS] },
      },
      orderBy: { createdAt: 'desc' },
      select: REVIEW_SELECT,
    });

  const pick = (rows: ReviewRow[]) => rows.find((r) => r.provider === repo.provider) ?? rows[0];

  const existing = pick(await find());
  if (existing) return existing;

  if (pr.headSha !== headSha) {
    throw new HttpError('conflict', 'head_sha does not match a review waiting for this Action');
  }
  if (!isActionProvider(repo.provider)) {
    throw new HttpError('conflict', 'This repository is not configured for a GitHub Action reviewer');
  }
  // Same creation path as the webhook (waiting_action, no event); a race with the webhook is fine.
  await requestReview({
    pullRequestId: pr.id,
    headSha,
    provider: repo.provider,
    orgId: repo.orgId,
    repoId: repo.id,
  });
  const created = pick(await find());
  if (!created) throw new HttpError('internal', 'Could not create review');
  return created;
}

/** `{ "error": "no_output" }` → review failed / invalid_output. No finalize. */
async function ingestNoOutput(review: ReviewRow, repoId: string): Promise<Response> {
  if (review.startedAt || (review.status === 'failed' && review.errorCode === 'invalid_output')) {
    return json({ reviewId: review.id, duplicate: true }, 200);
  }
  const res = await prisma.review.updateMany({
    where: { id: review.id, status: 'waiting_action', startedAt: null },
    data: {
      status: 'failed',
      errorCode: 'invalid_output',
      errorMessage: 'The GitHub Action finished without writing review.json',
      finishedAt: new Date(),
    },
  });
  if (res.count === 0) throw new HttpError('conflict', 'Review is no longer waiting for the Action');
  logger.info({ reviewId: review.id, repoId }, 'ingest: action produced no output');
  return json({ reviewId: review.id, duplicate: false }, 200);
}

/**
 * Saves the Action's result and queues `review/finalize`.
 * The review stays `waiting_action` until finalize completes it (state machine:
 * `waiting_action → completed`); `startedAt` marks "result received" and is the idempotency claim.
 */
async function ingestResult(
  review: ReviewRow,
  result: ReviewResult,
  changedFiles: number,
  repoId: string,
): Promise<Response> {
  if (review.startedAt) return json({ reviewId: review.id, duplicate: true }, 200);
  if (review.status !== 'waiting_action') {
    throw new HttpError('conflict', `Review is ${review.status}, not waiting for the Action`);
  }

  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.review.updateMany({
      where: { id: review.id, status: 'waiting_action', startedAt: null },
      data: {
        startedAt: new Date(),
        filesTotal: changedFiles,
        filesDone: changedFiles,
        summary: result.summary,
      },
    });
    if (res.count === 0) return false;
    await tx.issue.deleteMany({ where: { reviewId: review.id } });
    if (result.issues.length > 0) {
      await tx.issue.createMany({
        data: result.issues.map((i) => ({
          reviewId: review.id,
          file: i.file,
          line: i.line,
          severity: i.severity,
          category: i.category,
          title: i.title,
          explanation: i.explanation,
          suggestedFix: i.suggested_fix ?? null,
        })),
      });
    }
    return true;
  });

  if (!claimed) {
    // Lost a race with a concurrent submit (or a cancel / sweep). Re-read to tell which.
    const now = await prisma.review.findUnique({ where: { id: review.id }, select: REVIEW_SELECT });
    if (now?.startedAt) return json({ reviewId: review.id, duplicate: true }, 200);
    throw new HttpError('conflict', 'Review is no longer waiting for the Action');
  }

  try {
    // Ids only — never code, patches or tokens.
    await inngest.send({ name: 'review/finalize', data: { reviewId: review.id } });
  } catch (err) {
    // Undo the claim so the Action's retry (or a re-run) can submit again.
    await prisma
      .$transaction([
        prisma.issue.deleteMany({ where: { reviewId: review.id } }),
        prisma.review.update({ where: { id: review.id }, data: { startedAt: null } }),
      ])
      .catch(() => undefined);
    throw err;
  }

  logger.info(
    { reviewId: review.id, repoId, issues: result.issues.length },
    'ingest: action result accepted',
  );
  return json({ reviewId: review.id, duplicate: false }, 202);
}

/** POST /api/ingest/review */
export async function handleIngestReview(req: Request): Promise<Response> {
  try {
    const { repo, tokenHash } = await authenticate(req);
    if (!(await allowIngest(tokenHash))) {
      throw new HttpError('rate_limited', 'Too many ingest requests for this token; try again later');
    }

    const body = await parseBody(req);
    const isNoOutput = 'error' in body;
    const repoName = body.repo;
    const prNumber = body.pr_number;
    const headSha = body.head_sha;
    if (prNumber === undefined || !headSha) {
      throw new HttpError('bad_request', 'pr_number and head_sha are required');
    }
    if (repoName !== undefined && repoName.toLowerCase() !== repo.fullName.toLowerCase()) {
      throw new HttpError('conflict', 'repo does not match the repository of this ingest token');
    }
    if (!isNoOutput && repoName === undefined) {
      throw new HttpError('bad_request', 'repo is required');
    }

    const pr = await prisma.pullRequest.findUnique({
      where: { repoId_number: { repoId: repo.id, number: prNumber } },
      select: { id: true, state: true, headSha: true, changedFiles: true },
    });
    if (!pr || pr.state !== 'open') {
      throw new HttpError('conflict', 'Pull request not found or not open');
    }

    const review = await findOrCreateReview(repo, pr, headSha);
    return isNoOutput
      ? await ingestNoOutput(review, repo.id)
      : await ingestResult(review, body, pr.changedFiles, repo.id);
  } catch (err) {
    const res = errorResponse(err);
    if (res.status >= 500) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'ingest: unexpected error',
      );
    }
    return res;
  }
}

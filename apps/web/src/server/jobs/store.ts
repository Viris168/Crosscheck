// Database access for the review jobs. The interface keeps the Inngest handlers testable with an
// in-memory fake; `prismaJobsStore` is the real implementation.
import { prisma, Prisma } from '@app/db';
import {
  LIMITS,
  RepoSettingsSchema,
  type ErrorCode,
  type ProviderId,
  type RepoSettings,
  type ReviewIssue,
  type ReviewStatus,
  type RiskResult,
} from '@app/shared';

export interface ReviewContext {
  review: {
    id: string;
    status: ReviewStatus;
    provider: ProviderId;
    headSha: string;
    /** The provider's own risk score (max over chunks, or the Action's result). Input to computeRisk. */
    aiRiskScore: number | null;
    summary: string | null;
    githubReviewId: number | null;
  };
  pr: {
    id: string;
    number: number;
    title: string;
    body: string;
    baseRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  repo: {
    id: string;
    orgId: string;
    fullName: string;
    settings: RepoSettings;
    githubInstallationId: number;
  };
}

export interface StoredIssue extends ReviewIssue {
  id: string;
}

export interface ChunkSave {
  chunkIndex: number;
  chunkCount: number;
  /** The chunk's file paths: its issues are replaced (idempotent re-run). */
  paths: string[];
  issues: ReviewIssue[];
  summary: string;
}

export interface JobsStore {
  getReviewContext(reviewId: string): Promise<ReviewContext | null>;
  /** `queued` → `running` and clear any previous attempt's results. false if not `queued` any more. */
  markRunning(reviewId: string, now: Date): Promise<boolean>;
  setFilesTotal(reviewId: string, filesTotal: number): Promise<void>;
  /** Replace the chunk's issues, append its summary, add its files to `filesDone`. Atomic. */
  saveChunk(reviewId: string, chunk: ChunkSave): Promise<void>;
  /** After all chunks: exact `filesDone`, the AI risk score, and any warning. */
  finishChunks(
    reviewId: string,
    data: {
      filesDone: number;
      aiRiskScore: number | null;
      errorCode: ErrorCode | null;
      errorMessage: string | null;
    },
  ): Promise<void>;
  /** Mark failed unless already terminal (`completed` / `failed` / `cancelled`). Returns whether it changed. */
  fail(reviewId: string, code: ErrorCode, message: string, now: Date): Promise<boolean>;
  listIssues(reviewId: string): Promise<StoredIssue[]>;
  deleteIssues(reviewId: string, ids: string[]): Promise<void>;
  saveRisk(reviewId: string, risk: RiskResult): Promise<void>;
  markPosted(reviewId: string, githubReviewId: number, issueIds: string[]): Promise<void>;
  /** `running` / `waiting_action` → `completed`. Returns whether it changed. */
  complete(reviewId: string, now: Date): Promise<boolean>;
  sweep(now: Date): Promise<{ actionMissing: number; timedOut: number }>;
}

export const TERMINAL_STATUSES: readonly ReviewStatus[] = ['completed', 'failed', 'cancelled'];

export function parseSettings(raw: unknown): RepoSettings {
  const parsed = RepoSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : RepoSettingsSchema.parse({});
}

/** Multi-chunk summaries are stored as "**Part i/n:** …" sections; the marker makes appends idempotent. */
export function summaryPart(
  chunkIndex: number,
  chunkCount: number,
  summary: string,
): { marker: string; text: string } {
  const marker = `**Part ${chunkIndex + 1}/${chunkCount}:**`;
  return { marker, text: `${marker} ${summary}` };
}

// ---------------------------------------------------------------- Prisma implementation

const RESET_FIELDS = {
  errorCode: null,
  errorMessage: null,
  filesTotal: 0,
  filesDone: 0,
  aiRiskScore: null,
  riskScore: null,
  riskLevel: null,
  riskFactors: Prisma.DbNull,
  summary: null,
  githubReviewId: null,
  finishedAt: null,
} as const;

export const prismaJobsStore: JobsStore = {
  async getReviewContext(reviewId) {
    const r = await prisma.review.findUnique({
      where: { id: reviewId },
      include: { pullRequest: { include: { repo: { include: { installation: true } } } } },
    });
    if (!r) return null;
    const pr = r.pullRequest;
    const repo = pr.repo;
    return {
      review: {
        id: r.id,
        status: r.status,
        provider: r.provider,
        headSha: r.headSha,
        aiRiskScore: r.aiRiskScore,
        summary: r.summary,
        githubReviewId: r.githubReviewId === null ? null : Number(r.githubReviewId),
      },
      pr: {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        baseRef: pr.baseRef,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
      },
      repo: {
        id: repo.id,
        orgId: repo.orgId,
        fullName: repo.fullName,
        settings: parseSettings(repo.settings),
        githubInstallationId: repo.installation.githubInstallationId,
      },
    };
  },

  async markRunning(reviewId, now) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.review.updateMany({
        where: { id: reviewId, status: 'queued' },
        data: { ...RESET_FIELDS, status: 'running', startedAt: now },
      });
      if (count === 0) return false;
      await tx.issue.deleteMany({ where: { reviewId } });
      return true;
    });
  },

  async setFilesTotal(reviewId, filesTotal) {
    await prisma.review.update({ where: { id: reviewId }, data: { filesTotal } });
  },

  async saveChunk(reviewId, chunk) {
    await prisma.$transaction(async (tx) => {
      await tx.issue.deleteMany({ where: { reviewId, file: { in: chunk.paths } } });
      if (chunk.issues.length > 0) {
        await tx.issue.createMany({
          data: chunk.issues.map((i) => ({
            reviewId,
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
      await tx.review.update({
        where: { id: reviewId },
        data: { filesDone: { increment: chunk.paths.length } },
      });
      const summary = chunk.summary.trim();
      if (summary === '') return;
      if (chunk.chunkCount === 1) {
        await tx.review.update({ where: { id: reviewId }, data: { summary } });
        return;
      }
      // Concurrent chunks append in one statement (no lost updates); the marker skips a re-run.
      const { marker, text } = summaryPart(chunk.chunkIndex, chunk.chunkCount, summary);
      await tx.$executeRaw`
        UPDATE "Review" SET "summary" = CASE
          WHEN "summary" IS NULL OR "summary" = '' THEN ${text}
          WHEN strpos("summary", ${marker}) > 0 THEN "summary"
          ELSE "summary" || E'\n\n' || ${text}
        END
        WHERE "id" = ${reviewId}`;
    });
  },

  async finishChunks(reviewId, data) {
    await prisma.review.update({
      where: { id: reviewId },
      data: {
        filesDone: data.filesDone,
        aiRiskScore: data.aiRiskScore === null ? null : Math.round(data.aiRiskScore),
        errorCode: data.errorCode,
        errorMessage: data.errorMessage,
      },
    });
  },

  async fail(reviewId, code, message, now) {
    const { count } = await prisma.review.updateMany({
      where: { id: reviewId, status: { notIn: [...TERMINAL_STATUSES] } },
      data: { status: 'failed', errorCode: code, errorMessage: message, finishedAt: now },
    });
    return count > 0;
  },

  async listIssues(reviewId) {
    const rows = await prisma.issue.findMany({
      where: { reviewId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      file: r.file,
      line: r.line,
      severity: r.severity,
      category: r.category,
      title: r.title,
      explanation: r.explanation,
      ...(r.suggestedFix ? { suggested_fix: r.suggestedFix } : {}),
    }));
  },

  async deleteIssues(reviewId, ids) {
    if (ids.length === 0) return;
    await prisma.issue.deleteMany({ where: { reviewId, id: { in: ids } } });
  },

  async saveRisk(reviewId, risk) {
    await prisma.review.update({
      where: { id: reviewId },
      data: { riskScore: Math.round(risk.score), riskLevel: risk.level, riskFactors: risk.factors },
    });
  },

  async markPosted(reviewId, githubReviewId, issueIds) {
    await prisma.$transaction([
      prisma.review.update({
        where: { id: reviewId },
        data: { githubReviewId: BigInt(githubReviewId) },
      }),
      prisma.issue.updateMany({
        where: { reviewId, id: { in: issueIds } },
        data: { posted: true },
      }),
    ]);
  },

  async complete(reviewId, now) {
    const { count } = await prisma.review.updateMany({
      where: { id: reviewId, status: { in: ['running', 'waiting_action'] } },
      data: { status: 'completed', finishedAt: now },
    });
    return count > 0;
  },

  async sweep(now) {
    const actionCutoff = new Date(now.getTime() - LIMITS.actionTimeoutMs);
    const runCutoff = new Date(now.getTime() - LIMITS.reviewTimeoutMs);
    const action = await prisma.review.updateMany({
      where: { status: 'waiting_action', updatedAt: { lt: actionCutoff } },
      data: {
        status: 'failed',
        errorCode: 'action_missing',
        errorMessage: 'The GitHub Action did not report a result within 30 minutes.',
        finishedAt: now,
      },
    });
    const running = await prisma.review.updateMany({
      where: {
        status: 'running',
        OR: [{ startedAt: { lt: runCutoff } }, { startedAt: null, updatedAt: { lt: runCutoff } }],
      },
      data: {
        status: 'failed',
        errorCode: 'timeout',
        errorMessage: 'The review did not finish within 20 minutes.',
        finishedAt: now,
      },
    });
    return { actionMissing: action.count, timedOut: running.count };
  },
};

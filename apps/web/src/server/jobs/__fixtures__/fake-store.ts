// Test-only in-memory JobsStore with the same semantics as prismaJobsStore.
import type { ErrorCode, ReviewIssue, ReviewStatus, RiskResult } from '@app/shared';
import {
  TERMINAL_STATUSES,
  parseSettings,
  summaryPart,
  type JobsStore,
  type ReviewContext,
  type StoredIssue,
} from '../store';

export interface FakeReview {
  id: string;
  status: ReviewStatus;
  provider: ReviewContext['review']['provider'];
  headSha: string;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  filesTotal: number;
  filesDone: number;
  aiRiskScore: number | null;
  riskScore: number | null;
  risk: RiskResult | null;
  summary: string | null;
  githubReviewId: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export function createFakeStore(
  init: {
    status?: ReviewStatus;
    provider?: FakeReview['provider'];
    settings?: Record<string, unknown>;
    pr?: Partial<ReviewContext['pr']>;
    aiRiskScore?: number | null;
    summary?: string | null;
    issues?: ReviewIssue[];
  } = {},
) {
  let seq = 0;
  const review: FakeReview = {
    id: 'rev_1',
    status: init.status ?? 'queued',
    provider: init.provider ?? 'platform',
    headSha: 'abc123',
    errorCode: null,
    errorMessage: null,
    filesTotal: 0,
    filesDone: 0,
    aiRiskScore: init.aiRiskScore ?? null,
    riskScore: null,
    risk: null,
    summary: init.summary ?? null,
    githubReviewId: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
  };
  const pr: ReviewContext['pr'] = {
    id: 'pr_1',
    number: 7,
    title: 'Add feature',
    body: 'Implements the feature.',
    baseRef: 'main',
    additions: 100,
    deletions: 10,
    changedFiles: 3,
    ...init.pr,
  };
  const repo: ReviewContext['repo'] = {
    id: 'repo_1',
    orgId: 'org_1',
    fullName: 'acme/app',
    settings: parseSettings(init.settings ?? {}),
    githubInstallationId: 42,
  };
  let issues: StoredIssue[] = (init.issues ?? []).map((i) => ({ ...i, id: `iss_${++seq}` }));
  const postedIds = new Set<string>();

  const store: JobsStore = {
    async getReviewContext(id) {
      if (id !== review.id) return null;
      return {
        review: {
          id: review.id,
          status: review.status,
          provider: review.provider,
          headSha: review.headSha,
          aiRiskScore: review.aiRiskScore,
          summary: review.summary,
          githubReviewId: review.githubReviewId,
        },
        pr: { ...pr },
        repo: { ...repo },
      };
    },
    async markRunning(_id, now) {
      if (review.status !== 'queued') return false;
      Object.assign(review, {
        status: 'running',
        startedAt: now,
        errorCode: null,
        errorMessage: null,
        filesTotal: 0,
        filesDone: 0,
        aiRiskScore: null,
        riskScore: null,
        risk: null,
        summary: null,
        githubReviewId: null,
        finishedAt: null,
      });
      issues = [];
      return true;
    },
    async setFilesTotal(_id, n) {
      review.filesTotal = n;
    },
    async saveChunk(_id, chunk) {
      const paths = new Set(chunk.paths);
      issues = issues.filter((i) => !paths.has(i.file));
      issues.push(...chunk.issues.map((i) => ({ ...i, id: `iss_${++seq}` })));
      review.filesDone += chunk.paths.length;
      const summary = chunk.summary.trim();
      if (!summary) return;
      if (chunk.chunkCount === 1) {
        review.summary = summary;
        return;
      }
      const { marker, text } = summaryPart(chunk.chunkIndex, chunk.chunkCount, summary);
      if (!review.summary) review.summary = text;
      else if (!review.summary.includes(marker)) review.summary += `\n\n${text}`;
    },
    async finishChunks(_id, d) {
      review.filesDone = d.filesDone;
      review.aiRiskScore = d.aiRiskScore === null ? null : Math.round(d.aiRiskScore);
      review.errorCode = d.errorCode;
      review.errorMessage = d.errorMessage;
    },
    async fail(_id, code, message, now) {
      if (TERMINAL_STATUSES.includes(review.status)) return false;
      Object.assign(review, {
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        finishedAt: now,
      });
      return true;
    },
    async listIssues() {
      return issues.map((i) => ({ ...i }));
    },
    async deleteIssues(_id, ids) {
      const drop = new Set(ids);
      issues = issues.filter((i) => !drop.has(i.id));
    },
    async saveRisk(_id, risk) {
      review.risk = risk;
      review.riskScore = Math.round(risk.score);
    },
    async markPosted(_id, githubReviewId, ids) {
      review.githubReviewId = githubReviewId;
      ids.forEach((i) => postedIds.add(i));
    },
    async complete(_id, now) {
      if (review.status !== 'running' && review.status !== 'waiting_action') return false;
      Object.assign(review, { status: 'completed', finishedAt: now });
      return true;
    },
    async sweep() {
      return { actionMissing: 0, timedOut: 0 };
    },
  };

  return { store, review, pr, repo, issues: () => issues, postedIds };
}

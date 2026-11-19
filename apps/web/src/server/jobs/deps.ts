// Everything the review functions touch outside themselves. Handlers take a `JobDeps` so tests can
// swap in fakes; `realDeps()` wires the merged packages (and the lane E mocks until it merges).
import {
  fetchFileText,
  fetchPullRequestFiles,
  getInstallationOctokit,
  splitFullName,
} from '@app/github';
import { getProvider } from '@app/providers';
import type { ProviderId, ReviewFile, ReviewIssue, ReviewProvider, RiskResult } from '@app/shared';
// TODO(lane E): switch these two imports to '@app/github-comments' and '@app/scoring', then delete ./mocks.
import * as comments from './mocks/github-comments';
import * as scoring from './mocks/scoring';
import { logger } from '@/server/logger';
import { prismaJobsStore, type JobsStore } from './store';

export interface PrRef {
  installationId: number;
  fullName: string;
  prNumber: number;
}

export interface JobDeps {
  store: JobsStore;
  github: {
    listFiles(ref: PrRef): Promise<ReviewFile[]>;
    fileText(ref: PrRef, path: string, gitRef: string): Promise<string | null>;
    postReview(
      ref: PrRef,
      args: { headSha: string; files: ReviewFile[]; issues: ReviewIssue[]; summaryBody: string },
    ): Promise<{ githubReviewId: number; postedIssueIndexes: number[] }>;
  };
  getProvider(id: ProviderId): ReviewProvider;
  computeRisk: typeof scoring.computeRisk;
  isLineInDiff(patch: string, line: number): boolean;
  formatSummary(args: {
    risk: RiskResult;
    summary: string;
    issueCount: number;
    postedCount: number;
    provider: ProviderId;
    dashboardUrl: string;
  }): string;
  dashboardUrl(repoId: string, prNumber: number): string;
  now(): Date;
  log: JobLogger;
}

export function realDeps(): JobDeps {
  return {
    store: prismaJobsStore,
    github: {
      async listFiles({ installationId, fullName, prNumber }) {
        const { owner, repo } = splitFullName(fullName);
        return fetchPullRequestFiles(
          await getInstallationOctokit(installationId),
          owner,
          repo,
          prNumber,
        );
      },
      async fileText({ installationId, fullName }, path, gitRef) {
        const { owner, repo } = splitFullName(fullName);
        return fetchFileText(
          await getInstallationOctokit(installationId),
          owner,
          repo,
          path,
          gitRef,
        );
      },
      async postReview({ installationId, fullName, prNumber }, args) {
        return comments.postReview(await getInstallationOctokit(installationId), {
          fullName,
          prNumber,
          ...args,
        });
      },
    },
    getProvider: (id) => getProvider(id),
    computeRisk: scoring.computeRisk,
    isLineInDiff: comments.isLineInDiff,
    formatSummary: comments.formatSummary,
    dashboardUrl(repoId, prNumber) {
      const base = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
      return `${base}/repos/${encodeURIComponent(repoId)}/pulls/${prNumber}`;
    },
    now: () => new Date(),
    log: logger,
  };
}

/** The subset of Inngest's `step` the handlers use (tests pass a fake). */
export interface StepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sendEvent(
    id: string,
    payload: { name: 'review/finalize'; data: { reviewId: string } },
  ): Promise<unknown>;
}

export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HandlerCtx<D> {
  event: { data: D };
  step: StepTools;
  /** Zero-indexed attempt of the step being executed. Read it inside a step callback. */
  attempt: number;
}

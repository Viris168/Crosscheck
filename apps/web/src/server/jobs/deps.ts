// Everything the review functions touch outside themselves. Handlers take a `JobDeps` so tests can
// swap in fakes; `realDeps()` wires the real packages.
import * as githubPkg from '@app/github';
import {
  fetchFileText,
  fetchPullRequestFiles,
  getInstallationOctokit,
  splitFullName,
  type Octokit,
} from '@app/github';
import { getProvider } from '@app/providers';
import type {
  CiState,
  ProviderId,
  ReviewFile,
  ReviewIssue,
  ReviewProvider,
  RiskResult,
} from '@app/shared';
import * as comments from '@app/github-comments';
import * as scoring from '@app/scoring';
import { env } from '@/server/env';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';
import { nonRetriable } from './errors';
import { ensureClone, readCloneGraph, redisRepoLock, type GitAuth } from './repo-cache';
import { prismaJobsStore, type JobsStore } from './store';
import { prismaTreeStore, type TreePr, type TreeSyncDeps } from './tree-sync';

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

// --- branch tree (T2c) ---

/**
 * T2b's `@app/github` tree reads (tasks/T2b-github-reads.md). Until T2b is merged they are missing from
 * the package and `treeGithubApi()` returns stubs that fail the sync with a non-retriable error; once it
 * is merged the real functions are picked up with no change here. TODO(T2b): import them directly.
 */
export interface T2bTreeApi {
  listBranches(
    octokit: Octokit,
    fullName: string,
  ): Promise<{ defaultBranch: string; branches: { name: string; headSha: string }[] }>;
  listPullRequestsForTree(
    octokit: Octokit,
    fullName: string,
    opts?: { maxPages?: number },
  ): Promise<TreePr[]>;
  fetchCiState(
    octokit: Octokit,
    fullName: string,
    sha: string,
  ): Promise<{ state: CiState; counts: Record<string, number> }>;
  gitAuthForInstallation(
    installationId: number,
  ): Promise<{ url: string; env: Record<string, string>; expiresAt: Date }>;
}

export function treeGithubApi(pkg: object = githubPkg): T2bTreeApi {
  const found = pkg as Partial<T2bTreeApi>;
  const missing = (name: string) => () =>
    Promise.reject(nonRetriable('internal', `GitHub tree reads not available yet (${name})`));
  return {
    listBranches: found.listBranches ?? missing('listBranches'),
    listPullRequestsForTree: found.listPullRequestsForTree ?? missing('listPullRequestsForTree'),
    fetchCiState: found.fetchCiState ?? missing('fetchCiState'),
    gitAuthForInstallation: found.gitAuthForInstallation ?? missing('gitAuthForInstallation'),
  };
}

/** Wait this long for another process's clone lock before the step gives up (and Inngest retries). */
const TREE_LOCK_WAIT_MS = 30_000;

export function realTreeSyncDeps(): TreeSyncDeps {
  const api = treeGithubApi();
  const lock = redisRepoLock(getRedis());
  const cacheDir = env.REPO_CACHE_DIR;
  return {
    store: prismaTreeStore,
    github: {
      async listBranches(repo) {
        return api.listBranches(
          await getInstallationOctokit(repo.githubInstallationId),
          repo.fullName,
        );
      },
      async listPullRequests(repo) {
        return api.listPullRequestsForTree(
          await getInstallationOctokit(repo.githubInstallationId),
          repo.fullName,
        );
      },
      async fetchCiState(repo, sha) {
        return api.fetchCiState(
          await getInstallationOctokit(repo.githubInstallationId),
          repo.fullName,
          sha,
        );
      },
      async gitAuth(repo): Promise<GitAuth> {
        // VERIFY(T2b): the token is scoped to this one repo (repository_ids) with contents/metadata: read.
        const { url, env: gitEnv } = await api.gitAuthForInstallation(repo.githubInstallationId);
        return { url, env: gitEnv };
      },
    },
    cache: {
      ensureClone: (repo, auth) =>
        ensureClone(repo, auth, {
          cacheDir,
          lock,
          lockWaitMs: TREE_LOCK_WAIT_MS,
          assertNoContents: process.env.TREE_ASSERT_NO_CONTENTS === '1',
          log: logger,
        }),
      readGraph: (repo, heads) =>
        readCloneGraph(repo, heads, { cacheDir, lock, lockWaitMs: TREE_LOCK_WAIT_MS }),
    },
    now: () => new Date(),
    log: logger,
  };
}

import 'server-only';
import type { Issue, PullRequest, Repo, Review } from '@app/db';
import {
  RepoSettingsSchema,
  RiskFactorSchema,
  type RepoSettings,
  type ReviewDetail,
  type RiskResult,
} from '@app/shared';
import type { z } from 'zod';
import type { PullHeaderSchema, PullListItem } from '@app/shared';
import type { ReviewSummary } from '@/lib/pending-contracts';

type ReviewRisk = Pick<Review, 'riskScore' | 'riskLevel' | 'riskFactors'>;

export function riskOf(review: ReviewRisk): RiskResult | null {
  if (review.riskScore == null || review.riskLevel == null) return null;
  const factors = RiskFactorSchema.array().safeParse(review.riskFactors ?? []);
  return {
    score: review.riskScore,
    level: review.riskLevel,
    factors: factors.success ? factors.data : [],
  };
}

/** Stored settings JSON → full settings with defaults (bad stored values fall back to defaults). */
export function settingsOf(raw: unknown): RepoSettings {
  const parsed = RepoSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : RepoSettingsSchema.parse({});
}

export function toReviewDetail(
  review: Review & { issues: Issue[] },
  pullHeadSha: string,
): ReviewDetail {
  return {
    id: review.id,
    status: review.status,
    provider: review.provider,
    headSha: review.headSha,
    stale: review.headSha !== pullHeadSha,
    errorCode: review.errorCode,
    errorMessage: review.errorMessage,
    filesTotal: review.filesTotal,
    filesDone: review.filesDone,
    risk: riskOf(review),
    summary: review.summary,
    issues: review.issues.map((i) => ({
      id: i.id,
      posted: i.posted,
      file: i.file,
      line: i.line,
      severity: i.severity,
      category: i.category,
      title: i.title,
      explanation: i.explanation,
      ...(i.suggestedFix ? { suggested_fix: i.suggestedFix } : {}),
    })),
    createdAt: review.createdAt.toISOString(),
    finishedAt: review.finishedAt?.toISOString() ?? null,
  };
}

export function toReviewSummary(review: Review, pullHeadSha: string): ReviewSummary {
  return {
    id: review.id,
    status: review.status,
    provider: review.provider,
    headSha: review.headSha,
    stale: review.headSha !== pullHeadSha,
    createdAt: review.createdAt.toISOString(),
  };
}

export function toLatestReviewSummary(
  review: Pick<Review, 'status' | 'headSha' | 'riskScore' | 'riskLevel'> | null | undefined,
  pullHeadSha: string,
): PullListItem['latestReview'] {
  if (!review) return null;
  return {
    status: review.status,
    riskScore: review.riskScore,
    riskLevel: review.riskLevel,
    stale: review.headSha !== pullHeadSha,
  };
}

export function toPullHeader(
  pull: PullRequest,
  repo: Pick<Repo, 'fullName'>,
): z.input<typeof PullHeaderSchema> {
  return {
    id: pull.id,
    repoId: pull.repoId,
    repoFullName: repo.fullName,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    author: pull.author,
    state: pull.state,
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changedFiles,
    updatedAt: pull.updatedAt.toISOString(),
    htmlUrl: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

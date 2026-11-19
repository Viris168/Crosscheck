// Test-only JobDeps builder.
import type {
  ProviderId,
  ReviewChunkInput,
  ReviewChunkResult,
  ReviewFile,
  ReviewProvider,
} from '@app/shared';
import type { JobDeps } from '../deps';
import { formatSummary, isLineInDiff } from '@app/github-comments';
import { computeRisk } from '@app/scoring';
import type { JobsStore } from '../store';

export const silentLog = { info() {}, warn() {}, error() {} };

/** Provider fake: records inputs; one `medium` issue on the first file's first line. */
export function fakeProvider(
  impl?: (input: ReviewChunkInput) => Promise<ReviewChunkResult>,
): ReviewProvider & { inputs: ReviewChunkInput[] } {
  const inputs: ReviewChunkInput[] = [];
  return {
    id: 'platform',
    runsInWorker: true,
    inputs,
    async reviewChunk(input) {
      inputs.push(input);
      if (impl) return impl(input);
      const first = input.files[0];
      return {
        risk_score: 30 + input.chunkIndex,
        summary: `AI_SUMMARY chunk ${input.chunkIndex}`,
        issues: first
          ? [
              {
                file: first.path,
                line: 1,
                severity: 'medium',
                category: 'bug',
                title: 't',
                explanation: 'e',
              },
            ]
          : [],
      };
    },
  };
}

export function makeDeps(opts: {
  store: JobsStore;
  files: ReviewFile[];
  provider?: ReviewProvider;
  postReview?: JobDeps['github']['postReview'];
  fileText?: Record<string, string>;
}): JobDeps & { posts: Parameters<JobDeps['github']['postReview']>[1][] } {
  const posts: Parameters<JobDeps['github']['postReview']>[1][] = [];
  const provider = opts.provider ?? fakeProvider();
  return {
    posts,
    store: opts.store,
    github: {
      listFiles: async () => opts.files.map((f) => ({ ...f })),
      fileText: async (_ref, path) => opts.fileText?.[path] ?? null,
      postReview:
        opts.postReview ??
        (async (_ref, args) => {
          posts.push(args);
          return { githubReviewId: 9001, postedIssueIndexes: args.issues.map((_, i) => i) };
        }),
    },
    getProvider: (_id: ProviderId) => provider,
    computeRisk,
    isLineInDiff,
    formatSummary,
    dashboardUrl: (repoId, n) => `https://app.test/repos/${repoId}/pulls/${n}`,
    now: () => new Date('2026-11-19T12:00:00Z'),
    log: silentLog,
  };
}

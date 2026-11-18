import type { ReviewChunkInput, ReviewChunkResult, ReviewProvider } from '@app/shared';

export type MockProvider = Omit<ReviewProvider, 'id'> & { id: 'mock' };

/** First new-side line number of the first hunk in a patch, or 1. */
function firstNewLine(patch: string): number {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(patch);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** Deterministic fixture result: one `low` test issue on the first file of the chunk. Test only. */
export function mockReview(input: ReviewChunkInput): ReviewChunkResult {
  const first = input.files[0];
  return {
    risk_score: 42,
    summary: `Mock review of chunk ${input.chunkIndex + 1}/${input.chunkCount} (${input.files.length} files).`,
    issues: first
      ? [
          {
            file: first.path,
            line: firstNewLine(first.patch),
            severity: 'low',
            category: 'test',
            title: 'Mock issue',
            explanation: 'Deterministic issue produced by the mock provider.',
          },
        ]
      : [],
    model: 'mock',
  };
}

export const mockProvider: MockProvider = {
  id: 'mock',
  runsInWorker: true,
  async reviewChunk(input) {
    return mockReview(input);
  },
};

// Numbers from docs/essential-architecture.md "Limits". Lanes import these instead of re-typing them.
export const LIMITS = {
  chunkTokens: 60_000,
  totalTokens: 400_000,
  concurrentChunkCalls: 3,
  providerCallTimeoutMs: 90_000,
  reviewTimeoutMs: 20 * 60_000,
  actionTimeoutMs: 30 * 60_000,
  maxInlineComments: 50,
  maxIngestBytes: 1_000_000,
  reviewsPerOrgConcurrency: 3,
} as const;

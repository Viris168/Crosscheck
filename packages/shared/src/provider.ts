import type { ErrorCode, ProviderId } from './enums';
import type { ReviewIssue } from './review-result';

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  patch: string;
}

export interface ReviewChunkInput {
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  /** PR title + description = intent. */
  title: string;
  body: string;
  /** CHANGE_NOTES.md / linked issue text, if found. */
  intentNotes?: string;
  /** AGENTS.md / repo review rules. */
  guidelines?: string;
  files: ReviewFile[];
  chunkIndex: number;
  chunkCount: number;
}

export interface ReviewChunkResult {
  risk_score: number;
  summary: string;
  issues: ReviewIssue[];
  model?: string;
}

export interface ProviderContext {
  orgId: string;
  userId?: string;
  /** `repo.settings.model`, if set. Providers fall back to their env/default model. */
  model?: string;
}

export interface ReviewProvider {
  id: ProviderId;
  /** true = runs inside our Inngest functions; false for *_action providers. */
  runsInWorker: boolean;
  reviewChunk(input: ReviewChunkInput, ctx: ProviderContext): Promise<ReviewChunkResult>;
}

export class ProviderError extends Error {
  constructor(
    public code: ErrorCode,
    msg: string,
  ) {
    super(msg);
    this.name = 'ProviderError';
  }
}

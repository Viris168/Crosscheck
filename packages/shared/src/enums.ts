export const ProviderId = ['claude_action', 'codex_chatgpt', 'codex_action', 'platform'] as const;
export type ProviderId = (typeof ProviderId)[number];

export const ReviewStatus = [
  'queued',
  'running',
  'waiting_action',
  'completed',
  'failed',
  /** Stopped by a user before it ran (from `queued` or `waiting_action`). Terminal. */
  'cancelled',
] as const;
export type ReviewStatus = (typeof ReviewStatus)[number];

/** Why a review failed (or a warning on a completed review, e.g. `too_large`). */
export const ErrorCode = [
  'too_large',
  'provider_auth',
  'rate_limited',
  'timeout',
  'action_missing',
  'invalid_output',
  'github_error',
  'internal',
] as const;
export type ErrorCode = (typeof ErrorCode)[number];

export const Severity = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof Severity)[number];

export const Category = ['security', 'bug', 'performance', 'style', 'test'] as const;
export type Category = (typeof Category)[number];

// --- extensions (not in the original contract list, needed by db + API) ---

export const PullRequestState = ['open', 'closed', 'merged'] as const;
export type PullRequestState = (typeof PullRequestState)[number];

/** Better Auth organization plugin roles. */
export const MemberRole = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MemberRole)[number];

/** Providers that run inside our Inngest functions (vs. in the user's GitHub Action). */
export const JOB_PROVIDERS = ['platform', 'codex_chatgpt'] as const satisfies readonly ProviderId[];
export const ACTION_PROVIDERS = [
  'claude_action',
  'codex_action',
] as const satisfies readonly ProviderId[];

export function isActionProvider(id: ProviderId): boolean {
  return (ACTION_PROVIDERS as readonly ProviderId[]).includes(id);
}

// --- branch tree (tasks/T-branch-tree.md); mirror the Prisma enums ---

/** Status of a repo's commits-only clone + snapshot (`RepoGraph.status`). */
export const TreeSyncStatus = ['idle', 'syncing', 'ready', 'failed'] as const;
export type TreeSyncStatus = (typeof TreeSyncStatus)[number];

/** Combined check runs + commit statuses for one commit. */
export const CiState = ['success', 'failure', 'pending', 'neutral', 'none'] as const;
export type CiState = (typeof CiState)[number];

/** How a branch was detected as merged: a merged PR, or its content found in the target. */
export const MergedVia = ['pr', 'rebased', 'squashed'] as const;
export type MergedVia = (typeof MergedVia)[number];

/** Which compare-with rule picked a branch's target (first match wins, in this order). */
export const CompareWhy = ['override', 'pr', 'recorded', 'inferred', 'default'] as const;
export type CompareWhy = (typeof CompareWhy)[number];

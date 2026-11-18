import { describe, expect, it } from 'vitest';
import {
  ACTION_PROVIDERS,
  Category,
  ErrorCode,
  isActionProvider,
  JOB_PROVIDERS,
  ProviderId,
  ReviewStatus,
  Severity,
} from './enums';

describe('enums', () => {
  it('match the locked contract values', () => {
    expect(ProviderId).toEqual(['claude_action', 'codex_chatgpt', 'codex_action', 'platform']);
    expect(ReviewStatus).toEqual([
      'queued',
      'running',
      'waiting_action',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(ErrorCode).toEqual([
      'too_large',
      'provider_auth',
      'rate_limited',
      'timeout',
      'action_missing',
      'invalid_output',
      'github_error',
      'internal',
    ]);
    expect(Severity).toEqual(['low', 'medium', 'high', 'critical']);
    expect(Category).toEqual(['security', 'bug', 'performance', 'style', 'test']);
  });

  it('splits providers into job and action providers, covering all', () => {
    expect([...JOB_PROVIDERS, ...ACTION_PROVIDERS].sort()).toEqual([...ProviderId].sort());
    expect(isActionProvider('claude_action')).toBe(true);
    expect(isActionProvider('codex_action')).toBe(true);
    expect(isActionProvider('platform')).toBe(false);
    expect(isActionProvider('codex_chatgpt')).toBe(false);
  });
});

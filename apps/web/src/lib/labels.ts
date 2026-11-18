import type { ProviderId, ReviewStatus, RiskLevel, Severity } from '@app/shared/client';

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude_action: 'Claude (GitHub Action)',
  codex_chatgpt: 'Codex (ChatGPT plan)',
  codex_action: 'Codex (GitHub Action)',
  platform: 'Platform default',
};

export const PROVIDER_SHORT: Record<ProviderId, string> = {
  claude_action: 'Claude Action',
  codex_chatgpt: 'Codex · ChatGPT',
  codex_action: 'Codex Action',
  platform: 'Platform',
};

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_action: 'Waiting for Action',
  completed: 'Completed',
  failed: 'Failed',
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const shortSha = (sha: string) => sha.slice(0, 7);

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

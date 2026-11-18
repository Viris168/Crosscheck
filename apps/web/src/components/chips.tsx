import type { ProviderId, ReviewStatus, RiskLevel, Severity } from '@app/shared/client';
import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  GitBranch,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { PROVIDER_SHORT, RISK_LABEL, SEVERITY_LABEL, STATUS_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

// Every chip carries text (and an icon), so color is never the only signal.

const STATUS_TONE: Record<ReviewStatus, BadgeTone> = {
  queued: 'neutral',
  running: 'blue',
  waiting_action: 'purple',
  completed: 'green',
  failed: 'red',
  cancelled: 'neutral',
};
const STATUS_ICON = {
  queued: Clock,
  running: Loader2,
  waiting_action: GitBranch,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
} satisfies Record<ReviewStatus, unknown>;

export function StatusChip({ status }: { status: ReviewStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={STATUS_TONE[status]} data-status={status}>
      <Icon aria-hidden className={cn(status === 'running' && 'animate-spin')} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const RISK_TONE: Record<RiskLevel, BadgeTone> = {
  low: 'green',
  medium: 'yellow',
  high: 'orange',
  critical: 'red',
};
const RISK_ICON = {
  low: ShieldCheck,
  medium: ShieldAlert,
  high: AlertTriangle,
  critical: AlertOctagon,
} satisfies Record<RiskLevel, unknown>;

export function RiskBadge({ level, score }: { level: RiskLevel; score?: number | null }) {
  const Icon = RISK_ICON[level];
  return (
    <Badge tone={RISK_TONE[level]} data-risk={level}>
      <Icon aria-hidden />
      {RISK_LABEL[level]}
      {score != null && <span className="tabular-nums">· {score}</span>}
    </Badge>
  );
}

const SEVERITY_TONE: Record<Severity, BadgeTone> = RISK_TONE;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

export function ProviderBadge({ provider }: { provider: ProviderId }) {
  return <Badge tone="neutral">{PROVIDER_SHORT[provider]}</Badge>;
}

export function StaleBadge() {
  return (
    <Badge tone="yellow" title="The PR has new commits since this review">
      <Clock aria-hidden />
      Stale
    </Badge>
  );
}

/** Green/red +/− pills. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">
        <span className="sr-only">additions </span>+{additions}
      </span>
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">
        <span className="sr-only">deletions </span>−{deletions}
      </span>
    </span>
  );
}

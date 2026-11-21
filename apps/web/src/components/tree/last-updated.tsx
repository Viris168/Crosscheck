'use client';

import { useEffect, useState } from 'react';

/** "4s ago", "3m ago", "2h ago", "5d ago". Future times (clock skew) count as 0 s. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "Last updated Xs ago" for the last sync, ticking every second; the exact time is in the tooltip. */
export function LastUpdated({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const date = new Date(at);
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      Last updated{' '}
      <time dateTime={at} title={date.toLocaleString()}>
        {formatAgo(now - date.getTime())}
      </time>
    </span>
  );
}

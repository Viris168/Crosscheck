import { createHash } from 'node:crypto';

/**
 * Weak ETag for GET /tree. Built from the sync state (`syncedAt`, plus `updatedAt` for status/error
 * changes), the caller's edit right, the compare-with overrides (applied at read time) and whether git
 * events arrive. Anything else in the body only changes when a sync writes a new snapshot.
 */
export function treeEtag(parts: {
  syncedAt: Date | null;
  updatedAt: Date | null;
  canEdit: boolean;
  overrides: Record<string, string>;
  liveEvents: boolean;
}): string {
  const overrides = Object.entries(parts.overrides).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const key = JSON.stringify([
    parts.syncedAt?.toISOString() ?? null,
    parts.updatedAt?.toISOString() ?? null,
    parts.canEdit,
    overrides,
    parts.liveEvents,
  ]);
  return `W/"${createHash('sha256').update(key).digest('base64url').slice(0, 27)}"`;
}

/** `If-None-Match` matches `etag` (weak comparison, RFC 9110 §13.1.2). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  const want = strip(etag);
  return ifNoneMatch.split(',').some((t) => t.trim() === '*' || strip(t) === want);
}

import type { ChangedFileSchema } from '@app/shared';
import type { z } from 'zod';

/**
 * Changed files for the dev seed PR (`pnpm db:seed`). Seed repos (ids `seed_*`) are not on GitHub, so
 * `fetchPullFiles` serves these outside production instead of calling the API (local dev, Playwright).
 */
export const SEED_PULL_FILES: z.infer<typeof ChangedFileSchema>[] = [
  {
    path: 'src/auth/session.ts',
    status: 'modified',
    additions: 6,
    deletions: 2,
    patch: [
      '@@ -26,10 +26,14 @@ export async function loadSession(id: string) {',
      '   const db = await getDb();',
      '-  const ttl = 3600;',
      '-  const now = Date.now();',
      '+  const ttl = SESSION_TTL_SECONDS;',
      '+  const now = clock.now();',
      '   if (!id) return null;',
      '+  // refresh before expiry',
      "+  const sql = `SELECT * FROM sessions WHERE id = '${id}'`;",
      '+  const rows = await db.raw(sql);',
      '+  if (rows.length === 0) return null;',
      '+  return refreshIfNeeded(rows[0], now, ttl);',
      ' }',
      ' ',
      ' export const SESSION_COOKIE = "sid";',
    ].join('\n'),
  },
  {
    path: 'src/auth/refresh.ts',
    status: 'added',
    additions: 18,
    deletions: 0,
    patch: [
      '@@ -0,0 +1,18 @@',
      "+import type { Session } from './types';",
      '+',
      '+const WINDOW_MS = 5 * 60_000;',
      '+',
      '+/**',
      '+ * Extends the session when it is about to expire.',
      '+ * Returns the session unchanged otherwise.',
      '+ */',
      '+export function refreshIfNeeded(session: Session | null, now: number, ttl: number) {',
      '+  // a missing cookie is handled by the caller',
      '+  const window = WINDOW_MS;',
      '+  const expiresAt = session.expiresAt;',
      '+  if (expiresAt - now > window) return session;',
      '+  return {',
      '+    ...session,',
      '+    expiresAt: now + ttl * 1000,',
      '+  };',
      '+}',
    ].join('\n'),
  },
  {
    path: 'README.md',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch:
      '@@ -1,3 +1,4 @@\n # web\n \n+Sessions refresh 5 minutes before they expire.\n See docs/.',
  },
];

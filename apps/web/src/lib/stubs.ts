// Stand-ins for lanes that are not merged yet. Replace each export with the real import once the
// lane lands (see tasks/F-frontend.md → "Mocks until other lanes merge").
import 'server-only';
import type { PullRequest, Repo } from '@app/db';
import { HttpError } from '@app/shared';
import type { z } from 'zod';
import type { ChangedFileSchema } from '@app/shared';

type ChangedFile = z.infer<typeof ChangedFileSchema>;

// ---------------------------------------------------------------- @app/workflow-templates (lane D)

export interface OpenWorkflowPrInput {
  githubInstallationId: number;
  repoFullName: string;
  provider: 'claude_action' | 'codex_action';
  model?: string;
}

/** TODO(lane D): replace with `openWorkflowPR` from `@app/workflow-templates`. */
export async function openWorkflowPR(
  _input: OpenWorkflowPrInput,
): Promise<{ prNumber: number; prUrl: string }> {
  throw new HttpError(
    'not_implemented',
    'Committing the workflow is not available yet. Add the workflow file to .github/workflows manually.',
  );
}

// ---------------------------------------------------------------- chatgptOAuth (@app/providers, lane C)

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

/** TODO(lane C): replace with `chatgptOAuth` from `@app/providers`. */
export const chatgptOAuth = {
  // VERIFY: Sign in with ChatGPT uses OAuth 2.0 authorization code + PKCE (S256); lane C owns the URLs.
  authorizeUrl(_args: { state: string; codeChallenge: string; redirectUri: string }): string {
    throw new HttpError('not_implemented', 'Sign in with ChatGPT is not available yet.');
  },
  async exchangeCode(_args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ChatGptTokens> {
    throw new HttpError('not_implemented', 'Sign in with ChatGPT is not available yet.');
  },
};

// ---------------------------------------------------------------- PR files (@/server/github, lane A)

/**
 * TODO(lane A): replace with the live GitHub "list PR files" fetch from `@/server/github`.
 * Until then: no files in production; in development the seed PR gets a fixed sample diff so the
 * Changed Files tab and inline issue markers can be exercised.
 */
export async function fetchPullFiles(
  repo: Pick<Repo, 'id' | 'fullName'>,
  pull: Pick<PullRequest, 'number' | 'headSha'>,
): Promise<ChangedFile[]> {
  if (process.env.NODE_ENV === 'production' || !repo.id.startsWith('seed_')) return [];
  void pull;
  return SEED_FILES;
}

const SEED_FILES: ChangedFile[] = [
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

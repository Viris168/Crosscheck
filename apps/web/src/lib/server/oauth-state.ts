import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const CHATGPT_OAUTH_COOKIE = 'chatgpt_oauth';
export const CHATGPT_OAUTH_COOKIE_PATH = '/api/oauth/chatgpt';
export const CHATGPT_OAUTH_MAX_AGE_S = 10 * 60;

const PendingAuthSchema = z.object({
  state: z.string().min(16),
  verifier: z.string().min(43),
  orgId: z.string().min(1),
  returnTo: z.string(),
});
export type PendingAuth = z.infer<typeof PendingAuthSchema>;

export function newPendingAuth(orgId: string, returnTo: string) {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  return { pending: { state, verifier, orgId, returnTo } satisfies PendingAuth, codeChallenge };
}

export function encodePending(p: PendingAuth): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

export function decodePending(raw: string | undefined): PendingAuth | null {
  if (!raw) return null;
  try {
    const parsed = PendingAuthSchema.safeParse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Only same-site relative paths ("/x", not "//evil" or "/\\evil"); anything else → fallback. */
export function safeReturnTo(raw: string | null | undefined, fallback = '/settings/connections') {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\'))
    return fallback;
  return raw;
}

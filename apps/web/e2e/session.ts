// Mocked login for e2e: creates a Better Auth session row for the seed owner and returns the signed
// cookie the browser would hold after a real GitHub login. Dev/test databases only.
import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from '@app/db';

export const SEED_USER_ID = 'seed_user_owner';
export const SEED_ORG_ID = 'seed_org_acme';
// VERIFY: Better Auth cookie name (no __Secure- prefix over http) and the better-call signature
// format `${token}.${base64(HMAC-SHA256(secret, token))}`, URI-encoded (better-auth 1.7.25).
export const SESSION_COOKIE = 'better-auth.session_token';

export async function createSeedSession(secret: string) {
  const token = randomBytes(24).toString('base64url');
  await prisma.session.create({
    data: {
      id: `e2e_${token.slice(0, 12)}`,
      token,
      userId: SEED_USER_ID,
      activeOrganizationId: SEED_ORG_ID,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return { token, cookieValue: encodeURIComponent(`${token}.${signature}`) };
}

export async function deleteE2eSessions() {
  await prisma.session.deleteMany({ where: { id: { startsWith: 'e2e_' } } });
}

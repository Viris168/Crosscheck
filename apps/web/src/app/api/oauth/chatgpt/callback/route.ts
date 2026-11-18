import { prisma } from '@app/db';
import { ChatGptCallbackQuery, encrypt, HttpError, safeEqual } from '@app/shared';
import { NextResponse, type NextRequest } from 'next/server';
import {
  CHATGPT_OAUTH_COOKIE,
  CHATGPT_OAUTH_COOKIE_PATH,
  decodePending,
  safeReturnTo,
} from '@/lib/server/oauth-state';
import { chatgptOAuth } from '@/lib/stubs';
import { auth, requireOrgMember } from '@/server/auth';
import { env } from '@/server/env';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

const redirectUri = () => new URL('/api/oauth/chatgpt/callback', env.PUBLIC_URL).toString();

/**
 * GET /api/oauth/chatgpt/callback?code&state — validates `state` against the httpOnly cookie set by
 * /start, exchanges the code (PKCE), stores the tokens encrypted, and redirects to the dashboard.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const pending = decodePending(req.cookies.get(CHATGPT_OAUTH_COOKIE)?.value);
  const returnTo = safeReturnTo(pending?.returnTo);
  const finish = (params: Record<string, string>) => {
    const url = new URL(returnTo, req.nextUrl.origin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = NextResponse.redirect(url);
    // One-shot: the state can never be replayed.
    res.cookies.set(CHATGPT_OAUTH_COOKIE, '', { path: CHATGPT_OAUTH_COOKIE_PATH, maxAge: 0 });
    return res;
  };

  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return NextResponse.redirect(new URL('/sign-in', req.nextUrl.origin));

    if (req.nextUrl.searchParams.has('error')) return finish({ error: 'access_denied' });
    const query = ChatGptCallbackQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return finish({ error: 'bad_request' });
    if (!pending || !safeEqual(pending.state, query.data.state)) {
      return finish({ error: 'invalid_state' });
    }

    await requireOrgMember(session.user.id, pending.orgId);
    const tokens = await chatgptOAuth.exchangeCode({
      code: query.data.code,
      codeVerifier: pending.verifier,
      redirectUri: redirectUri(),
    });

    const data = {
      encryptedToken: encrypt(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt ?? null,
    };
    await prisma.providerCredential.upsert({
      where: {
        orgId_userId_provider: {
          orgId: pending.orgId,
          userId: session.user.id,
          provider: 'codex_chatgpt',
        },
      },
      create: { ...data, orgId: pending.orgId, userId: session.user.id, provider: 'codex_chatgpt' },
      update: data,
    });
    logger.info({ orgId: pending.orgId }, 'chatgpt connected');
    return finish({ connected: 'chatgpt' });
  } catch (err) {
    if (err instanceof HttpError) return finish({ error: err.code });
    logger.error({ err: (err as Error).message }, 'chatgpt oauth callback failed');
    return finish({ error: 'internal' });
  }
}

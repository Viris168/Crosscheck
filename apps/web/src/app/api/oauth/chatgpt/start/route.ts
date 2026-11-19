import { chatgptOAuth } from '@app/providers';
import { HttpError } from '@app/shared';
import { NextResponse, type NextRequest } from 'next/server';
import {
  CHATGPT_OAUTH_COOKIE,
  CHATGPT_OAUTH_COOKIE_PATH,
  CHATGPT_OAUTH_MAX_AGE_S,
  encodePending,
  newPendingAuth,
  safeReturnTo,
} from '@/lib/server/oauth-state';
import { resolveCurrentOrgId } from '@/lib/server/org';
import { auth } from '@/server/auth';
import { env } from '@/server/env';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

const redirectUri = () => new URL('/api/oauth/chatgpt/callback', env.PUBLIC_URL).toString();

/**
 * GET /api/oauth/chatgpt/start?returnTo=/path — browser navigation, so failures redirect back to the
 * dashboard with `?error=<code>` instead of returning JSON.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  const back = (error: string) => {
    const url = new URL(returnTo, req.nextUrl.origin);
    url.searchParams.set('error', error);
    return NextResponse.redirect(url);
  };

  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return NextResponse.redirect(new URL('/sign-in', req.nextUrl.origin));
    const orgId = await resolveCurrentOrgId(session);
    if (!orgId) return back('no_org');

    const { pending, codeChallenge } = newPendingAuth(orgId, returnTo);
    const url = chatgptOAuth.authorizeUrl(pending.state, redirectUri(), { codeChallenge });
    const res = NextResponse.redirect(url);
    res.cookies.set(CHATGPT_OAUTH_COOKIE, encodePending(pending), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: CHATGPT_OAUTH_COOKIE_PATH,
      maxAge: CHATGPT_OAUTH_MAX_AGE_S,
    });
    return res;
  } catch (err) {
    if (err instanceof HttpError) return back(err.code);
    logger.error({ err: (err as Error).message }, 'chatgpt oauth start failed');
    return back('internal');
  }
}

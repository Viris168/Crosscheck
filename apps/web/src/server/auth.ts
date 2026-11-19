import 'server-only';
import { prisma } from '@app/db';
import { HttpError, type MemberRole } from '@app/shared';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins';
import { env } from './env';
import { logger } from './logger';

/**
 * Better Auth endpoints that create, update or delete orgs, members, invitations, teams or roles.
 * GitHub is the only source of members (task H), so they answer 404. Taken from
 * better-auth 1.7.25 `dist/plugins/organization`. Kept: `/organization/set-active` (org switcher)
 * and the read-only endpoints (get-*, list-*, check-slug, has-permission, set-active-team).
 */
export const DISABLED_ORG_PATHS = [
  '/organization/create',
  '/organization/update',
  '/organization/delete',
  '/organization/leave',
  '/organization/invite-member',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/cancel-invitation',
  '/organization/remove-member',
  '/organization/update-member-role',
  '/organization/create-team',
  '/organization/update-team',
  '/organization/remove-team',
  '/organization/add-team-member',
  '/organization/remove-team-member',
  '/organization/create-role',
  '/organization/update-role',
  '/organization/delete-role',
] as const;

/**
 * `session.create.after`: ask the jobs lane to sync the user's org memberships from GitHub.
 * Sends ids only, and never throws: a failed send must not block sign-in.
 */
export async function onSessionCreated(session: { userId: string }): Promise<void> {
  const { userId } = session;
  try {
    // Lazy import: jobs → github → auth would otherwise be a circular import.
    const { inngest } = await import('@/server/jobs');
    await inngest.send({ name: 'user/signed-in', data: { userId } });
  } catch (err) {
    logger.warn(
      { userId, err: err instanceof Error ? err.message : 'unknown' },
      'user/signed-in event not sent',
    );
  }
}

// VERIFY: Better Auth options (additionalFields, organization `schema` option, mapProfileToUser)
//         against the docs for the installed better-auth version.
// VERIFY: `disabledPaths`, `account.encryptOAuthTokens`, `overrideUserInfoOnSignIn`,
//         `allowUserToCreateOrganization` and `databaseHooks.session.create.after` were checked
//         against the better-auth 1.7.25 source in node_modules; re-check on upgrade.
export function createAuth() {
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            // Re-run mapProfileToUser on every sign-in so `login`/`avatarUrl` follow GitHub renames.
            overrideUserInfoOnSignIn: true,
            // Keep the GitHub login + avatar on our User row.
            mapProfileToUser: (profile: { login: string; avatar_url: string }) => ({
              login: profile.login,
              avatarUrl: profile.avatar_url,
            }),
          },
        }
      : undefined;

  return betterAuth({
    appName: 'AI Code Review',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    // Returns 404 for every path listed (matched after the /api/auth base path).
    disabledPaths: [...DISABLED_ORG_PATHS],
    account: {
      // Encrypt access/refresh tokens with BETTER_AUTH_SECRET. Existing plaintext GitHub tokens
      // (gho_/ghu_/ghr_…) aren't hex or `$ba$`-prefixed, so better-auth reads them as-is; they are
      // stored encrypted on the next sign-in.
      // VERIFY: rotating BETTER_AUTH_SECRET makes stored tokens unreadable (users must sign in again).
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            await onSessionCreated(session);
          },
        },
      },
    },
    user: {
      additionalFields: {
        login: { type: 'string', required: false, input: false },
        avatarUrl: { type: 'string', required: false, input: false },
      },
    },
    socialProviders: github,
    plugins: [
      organization({
        // Orgs are created from GitHub App installations only (ensureOrganization), never by users.
        allowUserToCreateOrganization: false,
        // Default roles are owner | admin | member; the creator becomes owner.
        creatorRole: 'owner',
        schema: {
          organization: {
            additionalFields: {
              githubAccountLogin: { type: 'string', required: false, input: false },
              githubAccountType: { type: 'string', required: false, input: false },
              plan: { type: 'string', required: false, input: false, defaultValue: 'free' },
            },
          },
        },
      }),
      // Must be last: lets server actions set auth cookies.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

const globalForAuth = globalThis as unknown as { auth?: Auth };

function getAuth(): Auth {
  return (globalForAuth.auth ??= createAuth());
}

/** Better Auth instance, created on first use (so `next build` needs no secrets). */
export const auth: Auth = new Proxy({} as Auth, {
  get: (_target, key) => Reflect.get(getAuth(), key),
  has: (_target, key) => Reflect.has(getAuth(), key),
});

/** Returns `{ user, session }` for the request's cookie, or throws 401. */
export async function requireSession(req: Request | { headers: Headers }): Promise<AuthSession> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw new HttpError('unauthorized', 'Sign in required');
  return session;
}

/**
 * Throws 403 unless `userId` is a member of `orgId` (optionally with one of `roles`).
 * Returns the membership.
 */
export async function requireOrgMember(
  userId: string,
  orgId: string,
  roles?: readonly MemberRole[],
): Promise<{ id: string; role: MemberRole }> {
  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { id: true, role: true },
  });
  if (!member) throw new HttpError('forbidden', 'Not a member of this organization');
  // Better Auth stores multiple roles comma-separated.
  const memberRoles = member.role.split(',').map((r) => r.trim()) as MemberRole[];
  if (roles && !roles.some((r) => memberRoles.includes(r))) {
    throw new HttpError('forbidden', 'Insufficient role');
  }
  return { id: member.id, role: memberRoles[0] ?? 'member' };
}

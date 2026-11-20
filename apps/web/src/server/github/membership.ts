import 'server-only';
import { randomUUID } from 'node:crypto';
import { prisma } from '@app/db';
import {
  GithubApiError,
  fetchAuthenticatedUser,
  fetchOrgMembership,
  getInstallationOctokit,
  isRepoCollaborator,
  listUserInstallationIds,
} from '@app/github';
import { auth } from '@/server/auth';
import { logger } from '@/server/logger';

export interface SyncResult {
  /** Org ids the user was added to. */
  joined: string[];
  /** Org ids the user was removed from. */
  left: string[];
}

interface Candidate {
  id: string;
  githubInstallationId: number;
  orgId: string;
  org: { githubAccountLogin: string | null; githubAccountType: string | null };
  repos: { fullName: string }[];
}

/** What GitHub says about the user and one installation's account. */
type Verdict =
  | { inOrg: false }
  | {
      inOrg: true;
      /** GitHub org admin (org install) or the personal account itself: may become owner. */
      ownerEligible: boolean;
    };

const errMessage = (err: unknown) => (err instanceof Error ? err.message : 'unknown');

/** Collaborator checks in flight at once for a personal install (one per active repo). */
const COLLABORATOR_CHECKS_AT_ONCE = 5;

interface UserToken {
  token: string;
  /** The linked GitHub account's numeric id (`Account.accountId`). */
  githubId: string;
}

/**
 * The user's GitHub App user-to-server token, refreshed by Better Auth when it has expired.
 * Returns null (never throws) when there is no usable token.
 */
async function getUserToken(userId: string): Promise<UserToken | null> {
  try {
    // better-auth 1.7.25 selects the account by its row id (`{ accountId, userId }`, strict
    // schema); the spec's `{ providerId: 'github', userId }` is rejected with a 400.
    const account = await prisma.account.findFirst({
      where: { userId, providerId: 'github' },
      select: { id: true, accountId: true },
    });
    if (!account) {
      logger.info({ userId }, 'no GitHub account linked; removals only');
      return null;
    }
    // VERIFY: called from server code without headers, `getAccessToken` resolves the user from
    //         `body.userId` and refreshes expired GitHub App user tokens (8h expiry) with the
    //         stored refresh token (checked against better-auth 1.7.25 source, not a live app).
    const res = await auth.api.getAccessToken({ body: { accountId: account.id, userId } });
    return res?.accessToken ? { token: res.accessToken, githubId: account.accountId } : null;
  } catch (err) {
    logger.info({ userId, err: errMessage(err) }, 'no usable GitHub user token; removals only');
    return null;
  }
}

/**
 * Sets `user.login` / `avatarUrl` from GitHub with the user's own token and returns the login to use.
 * better-auth 1.7.25 drops `input: false` fields returned by `mapProfileToUser`
 * (`parseAdditionalUserInputFromProviderProfile`), so this is where `login` is set and kept current
 * after a GitHub rename. The profile is trusted only when its numeric id matches the linked account.
 * Falls back to the stored login on any error.
 */
async function refreshLogin(
  userId: string,
  stored: { login: string | null; avatarUrl: string | null },
  gh: UserToken,
): Promise<string | null> {
  try {
    const profile = await fetchAuthenticatedUser(gh.token);
    if (String(profile.id) !== gh.githubId) {
      logger.warn({ userId }, 'GitHub profile does not match the linked account; login unchanged');
      return stored.login;
    }
    if (profile.login !== stored.login || profile.avatarUrl !== stored.avatarUrl) {
      await prisma.user.update({
        where: { id: userId },
        data: { login: profile.login, avatarUrl: profile.avatarUrl },
      });
    }
    return profile.login;
  } catch (err) {
    logger.info(
      { userId, err: errMessage(err) },
      'reading the GitHub profile failed; stored login used',
    );
    return stored.login;
  }
}

async function joinCandidateInstallationIds(userId: string, token: string): Promise<number[]> {
  try {
    return await listUserInstallationIds(token);
  } catch (err) {
    logger.info(
      { userId, err: errMessage(err) },
      'listing user installations failed; removals only',
    );
    return [];
  }
}

/**
 * Asks GitHub (with the installation token) whether `login` belongs to the installation's account.
 * Returns null when the installation must be skipped (unknown account type). Throws on GitHub errors.
 */
async function decide(c: Candidate, login: string): Promise<Verdict | null> {
  const accountLogin = c.org.githubAccountLogin;
  if (!accountLogin) return null;

  if (c.org.githubAccountType === 'Organization') {
    const octokit = await getInstallationOctokit(c.githubInstallationId);
    const membership = await fetchOrgMembership(octokit, accountLogin, login);
    if (!membership) return { inOrg: false };
    return { inOrg: true, ownerEligible: membership.role === 'admin' };
  }

  if (c.org.githubAccountType === 'User') {
    if (accountLogin.toLowerCase() === login.toLowerCase()) {
      return { inOrg: true, ownerEligible: true };
    }
    // Never `fetchRepoPermission !== 'none'`: public repos report `read` for every user.
    // Batches of 5 in parallel; stops after the first batch with a hit.
    const octokit = await getInstallationOctokit(c.githubInstallationId);
    for (let i = 0; i < c.repos.length; i += COLLABORATOR_CHECKS_AT_ONCE) {
      const batch = c.repos.slice(i, i + COLLABORATOR_CHECKS_AT_ONCE);
      const hits = await Promise.all(
        batch.map((repo) => isRepoCollaborator(octokit, repo.fullName, login)),
      );
      if (hits.some(Boolean)) return { inOrg: true, ownerEligible: false };
    }
    return { inOrg: false };
  }

  // Null type: an org from before task H. Set when the client accepts the new permissions.
  return null;
}

/**
 * Adds the user to `orgId`. The "has no owner" check and the insert run in one transaction with the
 * organization row locked, so two concurrent syncs can't both create an owner.
 */
async function addMember(orgId: string, userId: string, ownerEligible: boolean): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${orgId} FOR UPDATE`;
    let role = 'member';
    if (ownerEligible) {
      const owners = await tx.member.count({ where: { organizationId: orgId, role: 'owner' } });
      if (owners === 0) role = 'owner';
    }
    await tx.member.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      create: { id: randomUUID(), organizationId: orgId, userId, role },
      update: {},
    });
  });
}

/**
 * Adds/removes the user's org memberships to match GitHub. Safe to run repeatedly.
 *
 * Candidates: installations from `/user/installations` (join) plus the installations of orgs the
 * user is already a member of (leave), limited to installations we know whose org has an active
 * repo. Each candidate is decided with the installation token. Any error skips that org and leaves
 * its rows unchanged: an error never adds or removes anyone.
 */
export interface SyncOptions {
  /**
   * Only re-check the orgs the user is already in, with the stored login and installation tokens; the
   * user's own GitHub token isn't used, so nobody joins. For the scheduled prune.
   */
  removalsOnly?: boolean;
}

export async function syncUserMemberships(
  userId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { joined: [], left: [] };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { login: true, avatarUrl: true },
  });
  if (!user) return result;
  const gh = options.removalsOnly ? null : await getUserToken(userId);
  const login = gh ? await refreshLogin(userId, user, gh) : user.login;
  if (!login) {
    logger.info({ userId }, 'membership sync skipped: user has no GitHub login');
    return result;
  }

  const [ghInstallationIds, memberships] = await Promise.all([
    gh ? joinCandidateInstallationIds(userId, gh.token) : Promise.resolve([]),
    prisma.member.findMany({ where: { userId }, select: { organizationId: true } }),
  ]);
  const memberOrgIds = new Set(memberships.map((m) => m.organizationId));

  const candidates: Candidate[] = await prisma.installation.findMany({
    where: {
      OR: [
        { githubInstallationId: { in: ghInstallationIds } },
        { orgId: { in: [...memberOrgIds] } },
      ],
      repos: { some: { active: true } },
    },
    select: {
      id: true,
      githubInstallationId: true,
      orgId: true,
      org: { select: { githubAccountLogin: true, githubAccountType: true } },
      repos: { where: { active: true }, select: { fullName: true }, orderBy: { fullName: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // One decision per org (an org can have an old installation left over after a reinstall).
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.orgId)) continue;
    seen.add(c.orgId);
    const orgId = c.orgId;

    let verdict: Verdict | null;
    try {
      verdict = await decide(c, login);
    } catch (err) {
      if (
        err instanceof GithubApiError &&
        err.status === 403 &&
        c.org.githubAccountType === 'Organization'
      ) {
        // Members: read not accepted yet on this installation.
        await prisma.installation
          .update({ where: { id: c.id }, data: { needsMemberPermission: true } })
          .catch(() => undefined);
        logger.warn({ userId, orgId }, 'membership sync: org member permission missing');
      } else {
        logger.warn({ userId, orgId }, 'membership sync: GitHub check failed; org skipped');
      }
      continue;
    }
    if (!verdict) continue;

    const isMember = memberOrgIds.has(orgId);
    try {
      if (verdict.inOrg && !isMember) {
        await addMember(orgId, userId, verdict.ownerEligible);
        result.joined.push(orgId);
        logger.info({ userId, orgId }, 'membership sync: joined');
      } else if (!verdict.inOrg && isMember) {
        await prisma.member.deleteMany({ where: { organizationId: orgId, userId } });
        result.left.push(orgId);
        logger.info({ userId, orgId }, 'membership sync: left');
      }
    } catch {
      logger.warn({ userId, orgId }, 'membership sync: database write failed; org skipped');
    }
  }

  return result;
}

/**
 * Runs a removals-only sync for every user with a membership, so people GitHub no longer lists lose
 * their membership without waiting for their next sign-in. GitHub sends no `member` webhook to
 * installations on personal accounts (they can't hold the org Members permission), and an org
 * webhook can be missed while the app is down. One user's failure doesn't stop the others.
 */
export async function pruneRemovedMembers(): Promise<{ users: number; left: number }> {
  const rows = await prisma.member.findMany({ where: {}, select: { userId: true } });
  const userIds = [...new Set(rows.map((r) => r.userId))];
  let left = 0;
  for (const userId of userIds) {
    try {
      left += (await syncUserMemberships(userId, { removalsOnly: true })).left.length;
    } catch (err) {
      logger.warn({ userId, err: errMessage(err) }, 'member prune: user skipped');
    }
  }
  return { users: userIds.length, left };
}

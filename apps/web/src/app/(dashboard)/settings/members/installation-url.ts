import 'server-only';
import { prisma } from '@app/db';

/**
 * GitHub page for the org's installation, where the client accepts new App permissions.
 * Prefers an installation flagged `needsMemberPermission`. null when the org has no installation.
 */
export async function getInstallationSettingsUrl(orgId: string): Promise<string | null> {
  const inst = await prisma.installation.findFirst({
    where: { orgId },
    orderBy: [{ needsMemberPermission: 'desc' }, { createdAt: 'asc' }],
    select: {
      githubInstallationId: true,
      org: { select: { githubAccountLogin: true, githubAccountType: true } },
    },
  });
  if (!inst) return null;
  const id = inst.githubInstallationId;
  const login = inst.org.githubAccountLogin;
  // VERIFY: GitHub's installation settings URLs — org installs live under
  // /organizations/{org}/settings/installations/{id}, personal ones under /settings/installations/{id}.
  return inst.org.githubAccountType === 'Organization' && login
    ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

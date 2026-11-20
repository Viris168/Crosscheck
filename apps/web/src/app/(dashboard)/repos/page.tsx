import { InstallAppButton } from '@/components/install-app-button';
import { RepoList } from '@/components/repos/repo-list';
import { ADMIN_ROLES } from '@/lib/server/access';
import { getDashboardContext } from '@/lib/server/dashboard';
import { getInstallUrl } from '@/lib/server/install-url';

export const metadata = { title: 'Repositories · AI Code Review' };

export default async function ReposPage() {
  const [installUrl, { orgs, currentOrgId }] = await Promise.all([
    getInstallUrl(),
    getDashboardContext(),
  ]);
  // Better Auth stores several roles comma-separated. No current org: keep the install prompt.
  const role = orgs.find((o) => o.id === currentOrgId)?.role;
  const canManage =
    role === undefined ||
    role.split(',').some((r) => (ADMIN_ROLES as readonly string[]).includes(r.trim()));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Repositories</h1>
        {canManage && (
          <InstallAppButton
            href={installUrl}
            label="Add repositories"
            variant="outline"
            className="ml-auto"
          />
        )}
      </div>
      <RepoList installUrl={installUrl} canManage={canManage} />
    </div>
  );
}

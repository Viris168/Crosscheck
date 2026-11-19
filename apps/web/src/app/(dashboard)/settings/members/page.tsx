import { MembersList } from '@/components/members/members-list';
import { getDashboardContext } from '@/lib/server/dashboard';
import { getInstallUrl } from '@/lib/server/install-url';
import { NoOrg } from '../../no-org';
import { getInstallationSettingsUrl } from './installation-url';

export const metadata = { title: 'Members · AI Code Review' };

export default async function MembersPage() {
  const { session, orgs, currentOrgId } = await getDashboardContext();
  if (!currentOrgId) return <NoOrg installUrl={await getInstallUrl()} />;

  // Better Auth may store several roles comma-separated.
  const role = orgs.find((o) => o.id === currentOrgId)?.role ?? '';
  const isOwner = role.split(',').some((r) => r.trim() === 'owner');
  const permissionUrl = isOwner ? await getInstallationSettingsUrl(currentOrgId) : null;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Members</h1>
      <MembersList
        key={currentOrgId}
        orgId={currentOrgId}
        isOwner={isOwner}
        currentUserId={session.user.id}
        permissionUrl={permissionUrl}
      />
    </div>
  );
}

import { OrgOverview } from '@/components/overview/overview';
import { getDashboardContext } from '@/lib/server/dashboard';
import { getInstallUrl } from '@/lib/server/install-url';
import { NoOrg } from './no-org';

export default async function OverviewPage() {
  const { currentOrgId } = await getDashboardContext();
  if (!currentOrgId) return <NoOrg installUrl={await getInstallUrl()} />;
  return <OrgOverview orgId={currentOrgId} />;
}

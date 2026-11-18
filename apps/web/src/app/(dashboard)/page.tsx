import { OrgOverview } from '@/components/overview/overview';
import { getDashboardContext } from '@/lib/server/dashboard';
import { NoOrg } from './no-org';

export default async function OverviewPage() {
  const { currentOrgId } = await getDashboardContext();
  if (!currentOrgId) return <NoOrg />;
  return <OrgOverview orgId={currentOrgId} />;
}

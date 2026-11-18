import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth, type AuthSession } from '@/server/auth';
import { listUserOrgs, resolveCurrentOrgId, type OrgSummary } from './org';

export interface DashboardContext {
  session: AuthSession;
  orgs: OrgSummary[];
  currentOrgId: string | null;
}

/** Route guard for dashboard pages: signed-out users go to /sign-in. Cached per request. */
export const getDashboardContext = cache(async (): Promise<DashboardContext> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const [orgs, currentOrgId] = await Promise.all([
    listUserOrgs(session.user.id),
    resolveCurrentOrgId(session),
  ]);
  return { session, orgs, currentOrgId };
});

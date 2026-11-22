import 'server-only';
import { HttpError } from '@app/shared';
import { notFound } from 'next/navigation';
import { LinkTabs } from '@/components/ui/link-tabs';
import { requireRepoAccess } from '@/lib/server/access';
import { getDashboardContext } from '@/lib/server/dashboard';

/**
 * Loads the repo for a page with the same rule as the API routes (`requireRepoAccess`: org owner/admin, or a
 * GitHub collaborator). Everyone else gets the 404 page: no existence leak, no repo name.
 */
export async function loadRepoForPage(repoId: string) {
  const { session } = await getDashboardContext();
  try {
    const { id, fullName } = await requireRepoAccess(session.user.id, repoId);
    return { id, fullName };
  } catch (err) {
    if (err instanceof HttpError && (err.code === 'not_found' || err.code === 'forbidden'))
      notFound();
    throw err; // e.g. GitHub did not answer the collaborator check: fail closed
  }
}

export function RepoHeader({
  repo,
  active,
}: {
  repo: { id: string; fullName: string };
  active: 'pulls' | 'tree' | 'settings' | 'setup';
}) {
  const base = `/repos/${repo.id}`;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold">{repo.fullName}</h1>
      <LinkTabs
        label="Repository sections"
        tabs={[
          { href: `${base}/pulls`, label: 'Pull requests', active: active === 'pulls' },
          { href: `${base}/tree`, label: 'Branches', active: active === 'tree' },
          { href: `${base}/settings`, label: 'Settings', active: active === 'settings' },
          { href: `${base}/setup`, label: 'Setup', active: active === 'setup' },
        ]}
      />
    </div>
  );
}

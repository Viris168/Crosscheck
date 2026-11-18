import 'server-only';
import { prisma } from '@app/db';
import { notFound } from 'next/navigation';
import { LinkTabs } from '@/components/ui/link-tabs';
import { getDashboardContext } from '@/lib/server/dashboard';

/** Loads the repo for a page, enforcing org membership (404 otherwise — no existence leak). */
export async function loadRepoForPage(repoId: string) {
  const { session } = await getDashboardContext();
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, org: { members: { some: { userId: session.user.id } } } },
    select: { id: true, fullName: true },
  });
  if (!repo) notFound();
  return repo;
}

export function RepoHeader({
  repo,
  active,
}: {
  repo: { id: string; fullName: string };
  active: 'pulls' | 'settings' | 'setup';
}) {
  const base = `/repos/${repo.id}`;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold">{repo.fullName}</h1>
      <LinkTabs
        label="Repository sections"
        tabs={[
          { href: `${base}/pulls`, label: 'Pull requests', active: active === 'pulls' },
          { href: `${base}/settings`, label: 'Settings', active: active === 'settings' },
          { href: `${base}/setup`, label: 'Setup', active: active === 'setup' },
        ]}
      />
    </div>
  );
}

import { Suspense } from 'react';
import { SetupWizard } from '@/components/setup/setup-wizard';
import { loadRepoForPage, RepoHeader } from '../repo-header';

export default async function SetupPage({ params }: { params: Promise<{ repoId: string }> }) {
  const repo = await loadRepoForPage((await params).repoId);
  return (
    <div className="flex flex-col gap-6">
      <RepoHeader repo={repo} active="setup" />
      <Suspense>
        <SetupWizard repoId={repo.id} repoFullName={repo.fullName} />
      </Suspense>
    </div>
  );
}

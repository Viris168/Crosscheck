import { Suspense } from 'react';
import { PullList } from '@/components/pulls/pull-list';
import { loadRepoForPage, RepoHeader } from '../repo-header';

export default async function PullsPage({ params }: { params: Promise<{ repoId: string }> }) {
  const repo = await loadRepoForPage((await params).repoId);
  return (
    <div className="flex flex-col gap-6">
      <RepoHeader repo={repo} active="pulls" />
      <Suspense>
        <PullList repoId={repo.id} />
      </Suspense>
    </div>
  );
}

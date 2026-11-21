import { BranchTree } from '@/components/tree/branch-tree';
import { loadRepoForPage, RepoHeader } from '../repo-header';

export default async function TreePage({ params }: { params: Promise<{ repoId: string }> }) {
  const repo = await loadRepoForPage((await params).repoId);
  return (
    <div className="flex flex-col gap-6">
      <RepoHeader repo={repo} active="tree" />
      <BranchTree repoId={repo.id} repoFullName={repo.fullName} />
    </div>
  );
}

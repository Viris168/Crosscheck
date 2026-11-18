import { RepoList } from '@/components/repos/repo-list';

export const metadata = { title: 'Repositories · AI Code Review' };

export default function ReposPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      <RepoList />
    </div>
  );
}

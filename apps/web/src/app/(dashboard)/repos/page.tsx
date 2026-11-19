import { InstallAppButton } from '@/components/install-app-button';
import { RepoList } from '@/components/repos/repo-list';
import { getInstallUrl } from '@/lib/server/install-url';

export const metadata = { title: 'Repositories · AI Code Review' };

export default async function ReposPage() {
  const installUrl = await getInstallUrl();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Repositories</h1>
        <InstallAppButton
          href={installUrl}
          label="Add repositories"
          variant="outline"
          className="ml-auto"
        />
      </div>
      <RepoList installUrl={installUrl} />
    </div>
  );
}

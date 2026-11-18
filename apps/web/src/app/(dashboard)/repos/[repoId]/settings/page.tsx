import { RepoSettingsPage } from '@/components/settings/repo-settings-form';
import { loadRepoForPage, RepoHeader } from '../repo-header';

export default async function SettingsPage({ params }: { params: Promise<{ repoId: string }> }) {
  const repo = await loadRepoForPage((await params).repoId);
  return (
    <div className="flex flex-col gap-6">
      <RepoHeader repo={repo} active="settings" />
      <RepoSettingsPage repoId={repo.id} />
    </div>
  );
}

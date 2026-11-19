import { InstallAppButton } from '@/components/install-app-button';

export function NoOrg({ installUrl }: { installUrl: string | null }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed bg-background p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold">No organization yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Install the GitHub App on your account or organization to start reviewing pull requests.
        </p>
      </div>
      <InstallAppButton href={installUrl} />
    </div>
  );
}

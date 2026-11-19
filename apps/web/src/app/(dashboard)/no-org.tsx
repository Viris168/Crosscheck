import { InstallAppButton } from '@/components/install-app-button';
import { CheckAgainButton } from './check-again-button';

export function NoOrg({ installUrl }: { installUrl: string | null }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed bg-background p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold">No organization yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Install the GitHub App on your account or organization to start reviewing pull requests.
          If your team already installed it, check again to join.
        </p>
      </div>
      <div className="flex flex-wrap items-start justify-center gap-2">
        <InstallAppButton href={installUrl} />
      </div>
      <CheckAgainButton />
    </div>
  );
}

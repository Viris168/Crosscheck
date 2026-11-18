import { headers } from 'next/headers';
import { SignInButton, SignOutButton } from '@/components/auth-buttons';
import { auth } from '@/server/auth';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

// Placeholder home page (lane F replaces it) — only here to test GitHub login.
export default async function HomePage() {
  const requestHeaders = await headers();
  let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
  let authError = false;
  try {
    session = await auth.api.getSession({ headers: requestHeaders });
  } catch (err) {
    authError = true;
    logger.error({ err: (err as Error).message }, 'failed to load session');
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold">AI Code Review</h1>
      {authError ? (
        <p className="text-destructive">
          Auth is unavailable. Check DATABASE_URL and BETTER_AUTH_*.
        </p>
      ) : session ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
          <p>
            Signed in as <strong>{session.user.login ?? session.user.name}</strong>
            <span className="text-muted-foreground"> ({session.user.email})</span>
          </p>
          <SignOutButton />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
          <p className="text-muted-foreground">Not signed in.</p>
          <SignInButton />
        </div>
      )}
    </main>
  );
}

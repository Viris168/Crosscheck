import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignInButton } from '@/components/auth-buttons';
import { auth } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · AI Code Review' };

export default async function SignInPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect('/');
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border bg-background p-8 shadow-xs">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">AI Code Review</h1>
          <p className="text-sm text-muted-foreground">
            AI reviews for your GitHub pull requests. Sign in to continue.
          </p>
        </div>
        <SignInButton />
      </div>
    </main>
  );
}

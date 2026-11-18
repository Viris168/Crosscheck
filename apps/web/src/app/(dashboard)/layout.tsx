import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/auth-buttons';
import { NavLinks } from '@/components/shell/nav-links';
import { OrgSwitcher } from '@/components/shell/org-switcher';
import { getDashboardContext } from '@/lib/server/dashboard';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { session, orgs, currentOrgId } = await getDashboardContext();
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <Link href="/" className="font-semibold">
            AI Code Review
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-3">
            <OrgSwitcher orgs={orgs} currentOrgId={currentOrgId} />
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {session.user.login ?? session.user.name}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}

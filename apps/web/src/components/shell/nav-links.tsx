'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Overview', match: (p: string) => p === '/' },
  { href: '/repos', label: 'Repositories', match: (p: string) => p.startsWith('/repos') },
  {
    href: '/settings/connections',
    label: 'Connections',
    match: (p: string) => p.startsWith('/settings'),
  },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active = l.match(pathname);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

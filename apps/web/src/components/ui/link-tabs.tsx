import Link from 'next/link';
import { cn } from '@/lib/utils';

/** Tabs that are links (the selected tab lives in the URL). */
export function LinkTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: { href: string; label: string; active: boolean; count?: number }[];
}) {
  return (
    <nav aria-label={label} className="flex gap-1 border-b">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          scroll={false}
          aria-current={t.active ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            t.active
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
          {t.count != null && (
            <span className="rounded-full bg-secondary px-1.5 text-xs">{t.count}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

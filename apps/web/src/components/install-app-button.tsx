import { ExternalLink, Plus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Opens GitHub's install page for our App. Renders nothing when the URL is unknown. */
export function InstallAppButton({
  href,
  label = 'Install GitHub App',
  variant = 'default',
  className,
}: {
  href: string | null;
  label?: string;
  variant?: 'default' | 'outline';
  className?: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant, size: 'sm' }), className)}
    >
      <Plus aria-hidden /> {label} <ExternalLink aria-hidden />
    </a>
  );
}

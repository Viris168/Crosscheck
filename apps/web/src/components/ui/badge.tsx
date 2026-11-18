import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-secondary text-secondary-foreground',
        blue: 'border-blue-200 bg-blue-50 text-blue-800',
        green: 'border-green-200 bg-green-50 text-green-800',
        yellow: 'border-amber-200 bg-amber-50 text-amber-900',
        orange: 'border-orange-200 bg-orange-50 text-orange-900',
        red: 'border-red-200 bg-red-50 text-red-800',
        purple: 'border-violet-200 bg-violet-50 text-violet-800',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

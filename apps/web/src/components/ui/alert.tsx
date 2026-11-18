import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const tones = {
  info: 'border-blue-200 bg-blue-50 text-blue-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-950',
  error: 'border-red-200 bg-red-50 text-red-900',
  success: 'border-green-200 bg-green-50 text-green-900',
} as const;

export function Alert({
  tone = 'info',
  className,
  ...props
}: ComponentProps<'div'> & { tone?: keyof typeof tones }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

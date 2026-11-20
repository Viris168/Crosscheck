import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const field =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-24 font-mono', className)} {...props} />;
}

// Native <select> (keeps keyboard + mobile pickers) restyled: own chevron (`select-chevron` in
// globals.css), hover state, dark popup.
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        field,
        'select-chevron h-9 cursor-pointer appearance-none py-1 pr-9 font-medium transition-[color,background-color,box-shadow] hover:bg-accent disabled:cursor-not-allowed dark:scheme-dark',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium', className)} {...props} />;
}

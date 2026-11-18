import { cn } from '@/lib/utils';

export function Progress({
  value,
  max,
  label,
  className,
}: {
  value: number;
  max: number;
  label: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    >
      <div
        className="h-full rounded-full bg-blue-600 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

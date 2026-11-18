import { Alert } from '@/components/ui/alert';
import { ApiError } from '@/lib/api-client';

export function QueryError({ error, what }: { error: Error; what: string }) {
  const msg =
    error instanceof ApiError && (error.status === 404 || error.status === 403)
      ? `This ${what} does not exist or you don't have access to it.`
      : `Could not load this ${what}. Try again.`;
  return <Alert tone="error">{msg}</Alert>;
}

import { ProviderError, type ErrorCode } from '@app/shared';

/** Shape shared by Anthropic + OpenAI SDK errors (both expose `status`, and OpenAI also `code`). */
interface HttpishError {
  status?: number;
  code?: unknown;
  name?: string;
  error?: { type?: unknown; code?: unknown } | undefined;
}

/** Map an HTTP status (and optional provider error code) to our `ErrorCode`. */
export function codeForStatus(status: number | undefined, providerCode?: string): ErrorCode {
  if (providerCode === 'insufficient_quota' || providerCode === 'rate_limit_exceeded') {
    return 'rate_limited';
  }
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 429) return 'rate_limited';
  // 529 = Anthropic "overloaded": treat like a rate limit so lane B retries it.
  if (status === 529) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  return 'internal';
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    err.name === 'APIConnectionTimeoutError' ||
    /timed? ?out/i.test(err.message)
  );
}

function providerCodeOf(e: HttpishError): string | undefined {
  if (typeof e.code === 'string') return e.code;
  const inner = e.error;
  if (inner && typeof inner.code === 'string') return inner.code;
  if (inner && typeof inner.type === 'string') return inner.type;
  return undefined;
}

/**
 * Turn anything thrown by an SDK / fetch into a `ProviderError`.
 * Messages are generic on purpose: provider error bodies can echo request content, never log/propagate them.
 */
export function toProviderError(err: unknown, label: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isTimeoutError(err)) return new ProviderError('timeout', `${label}: request timed out`);
  const e = (typeof err === 'object' && err !== null ? err : {}) as HttpishError;
  if (typeof e.status === 'number') {
    const code = codeForStatus(e.status, providerCodeOf(e));
    return new ProviderError(code, `${label}: HTTP ${e.status}`);
  }
  return new ProviderError('internal', `${label}: request failed`);
}

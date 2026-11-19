import { ErrorCode, ProviderError } from '@app/shared';
import { NonRetriableError } from 'inngest';

// A failed step reaches the handler as an Inngest `StepError` that carries only the serialized
// name + message of what was thrown, so the `ErrorCode` travels as a `[code]` message prefix.

const PREFIX = /^\[([a-z_]+)\]\s*/;

export function errorCodeOf(err: unknown): ErrorCode {
  if (err instanceof ProviderError) return err.code;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === 'string') {
      const m = PREFIX.exec(msg);
      if (m && (ErrorCode as readonly string[]).includes(m[1]!)) return m[1] as ErrorCode;
    }
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && (ErrorCode as readonly string[]).includes(code)) {
      return code as ErrorCode;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return 'internal';
}

/** Message without the `[code]` prefix. Never contains code, patches or AI text (we build it). */
export function errorMessageOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(PREFIX, '').slice(0, 500);
}

/** An error to throw from a step that Inngest will retry (up to the function's `retries`). */
export function retriable(code: ErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

/** An error to throw from a step that Inngest must not retry. */
export function nonRetriable(code: ErrorCode, message: string): NonRetriableError {
  return new NonRetriableError(`[${code}] ${message}`);
}

/**
 * Retry policy for provider calls (tech-stack.md → Background jobs):
 * timeout / rate_limited → retried (function `retries: 2`); invalid_output → one retry;
 * provider_auth → never. Everything else (internal, github_error) uses the default retries.
 */
export function providerFailure(err: unknown, attempt: number): Error {
  const code = errorCodeOf(err);
  // ProviderError messages are generic by contract (lane C): no request/response bodies.
  const message = err instanceof ProviderError ? err.message : 'chunk review failed';
  if (code === 'provider_auth') return nonRetriable(code, message);
  if (code === 'invalid_output' && attempt >= 1) return nonRetriable(code, message);
  return retriable(code, message);
}

/** Most specific first: what the user should fix / see when every chunk failed. */
const SPECIFICITY: readonly ErrorCode[] = [
  'provider_auth',
  'rate_limited',
  'timeout',
  'invalid_output',
  'too_large',
  'github_error',
  'action_missing',
  'internal',
];

export function mostSpecific(codes: readonly ErrorCode[]): ErrorCode {
  for (const c of SPECIFICITY) if (codes.includes(c)) return c;
  return 'internal';
}

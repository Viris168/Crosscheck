import { ApiErrorSchema } from '@app/shared/client';
import type { z } from 'zod';

/** Non-2xx response from our REST API: `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static async from(res: Response): Promise<ApiError> {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    const parsed = ApiErrorSchema.safeParse(body);
    return parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message)
      : new ApiError(res.status, 'http_error', res.statusText || `HTTP ${res.status}`);
  }
}

/** Typed fetch: parses the response with the shared zod schema. */
export async function apiFetch<T extends z.ZodType>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw await ApiError.from(res);
  return schema.parse(await res.json());
}

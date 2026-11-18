import { z } from 'zod';

/** Codes for non-2xx REST responses. (Review failures use `ErrorCode` from enums.) */
export const ApiErrorCode = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'not_implemented',
  'internal',
] as const;
export type ApiErrorCode = (typeof ApiErrorCode)[number];

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

/** Every non-2xx response. */
export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

/** Throw from route handlers / server helpers; turn into a Response with `errorResponse`. */
export class HttpError extends Error {
  readonly status: number;
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? API_ERROR_STATUS[code];
  }
}

export function errorBody(code: ApiErrorCode | string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/**
 * Maps any thrown value to a JSON error Response:
 * HttpError → its status; ZodError → 400; anything else → 500 (message hidden).
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(errorBody(err.code, err.message), { status: err.status });
  }
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return Response.json(errorBody('bad_request', `${where}${first?.message ?? 'Invalid input'}`), {
      status: 400,
    });
  }
  return Response.json(errorBody('internal', 'Internal server error'), { status: 500 });
}

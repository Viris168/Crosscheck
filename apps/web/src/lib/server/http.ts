import 'server-only';
import { errorResponse, HttpError } from '@app/shared';
import { z } from 'zod';
import { logger } from '@/server/logger';

type RouteContext<P> = { params: Promise<P> };

/**
 * Wraps a route handler: awaits params, maps thrown errors to `{ error: { code, message } }`
 * (HttpError → its status, ZodError → 400, anything else → 500 with the message hidden).
 */
export function route<P = Record<string, never>>(
  handler: (req: Request, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: RouteContext<P>): Promise<Response> => {
    try {
      return await handler(req, await ctx.params);
    } catch (err) {
      if (!(err instanceof HttpError) && !(err instanceof z.ZodError)) {
        logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            path: new URL(req.url).pathname,
          },
          'route handler failed',
        );
      }
      return errorResponse(err);
    }
  };
}

/** Validates the outgoing body with the shared response schema, then serializes it. */
export function json<T extends z.ZodType>(schema: T, data: z.input<T>, init?: ResponseInit) {
  return Response.json(schema.parse(data), init);
}

export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams);
}

/** Reads a JSON body; an empty body counts as `{}`. Malformed JSON → 400. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('bad_request', 'Request body must be valid JSON');
  }
}

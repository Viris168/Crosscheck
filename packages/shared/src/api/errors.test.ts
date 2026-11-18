import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorSchema, errorResponse, HttpError } from './errors';

describe('HttpError / errorResponse', () => {
  it('maps HttpError codes to statuses', async () => {
    const res = errorResponse(new HttpError('forbidden', 'Not a member'));
    expect(res.status).toBe(403);
    expect(ApiErrorSchema.parse(await res.json())).toEqual({
      error: { code: 'forbidden', message: 'Not a member' },
    });
    expect(new HttpError('payload_too_large', 'big').status).toBe(413);
    expect(new HttpError('conflict', 'x', 418).status).toBe(418);
  });

  it('maps ZodError to 400 with the failing path', async () => {
    const err = z.object({ state: z.enum(['open']) }).safeParse({ state: 'x' }).error;
    const res = errorResponse(err);
    expect(res.status).toBe(400);
    const body = ApiErrorSchema.parse(await res.json());
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toMatch(/^state: /);
  });

  it('hides unknown errors as 500', async () => {
    const res = errorResponse(new Error('db password is hunter2'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Internal server error' },
    });
  });
});

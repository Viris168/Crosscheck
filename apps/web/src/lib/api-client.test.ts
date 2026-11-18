import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiFetch } from './api-client';

const Schema = z.object({ ok: z.boolean() });

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('parses a successful response and sends JSON headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, extra: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/api/x', Schema, { method: 'POST' })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('throws ApiError with the server code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 'forbidden', message: 'nope' } }, { status: 403 }),
        ),
    );
    const err = await apiFetch('/api/x', Schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'nope' });
  });

  it('handles non-JSON errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>', { status: 502, statusText: 'Bad Gateway' })),
    );
    await expect(apiFetch('/api/x', Schema)).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
  });

  it('throws when the response does not match the schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: 'yes' })));
    await expect(apiFetch('/api/x', Schema)).rejects.toBeInstanceOf(z.ZodError);
  });
});

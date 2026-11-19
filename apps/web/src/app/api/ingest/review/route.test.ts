import { describe, expect, it, vi } from 'vitest';

const handleIngestReview = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 202 })));
vi.mock('@/server/ingest', () => ({ handleIngestReview }));

const route = await import('./route');

describe('POST /api/ingest/review route', () => {
  it('runs on the node runtime', () => {
    expect(route.runtime).toBe('nodejs');
  });

  it('delegates to @/server/ingest', async () => {
    const req = new Request('http://localhost/api/ingest/review', { method: 'POST', body: '{}' });
    const res = await route.POST(req);
    expect(res.status).toBe(202);
    expect(handleIngestReview).toHaveBeenCalledWith(req);
  });
});

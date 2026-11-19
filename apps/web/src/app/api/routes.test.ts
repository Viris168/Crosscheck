import { HealthResponse } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { GET as health } from './health/route';

describe('foundation API routes', () => {
  it('GET /api/health → 200 { ok: true }', async () => {
    const res = health();
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({ ok: true });
  });

  // webhooks/github (lane A) and ingest/review (lane D) are implemented; their tests live in
  // src/server/github and src/server/ingest.
});

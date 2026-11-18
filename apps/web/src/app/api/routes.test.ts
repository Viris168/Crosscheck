import { ApiErrorSchema, HealthResponse } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { GET as health } from './health/route';
import { POST as ingest } from './ingest/review/route';
import * as ingestRoute from './ingest/review/route';
import { POST as webhook } from './webhooks/github/route';
import * as webhookRoute from './webhooks/github/route';

describe('foundation API routes', () => {
  it('GET /api/health → 200 { ok: true }', async () => {
    const res = health();
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({ ok: true });
  });

  it.each([
    ['webhooks/github', webhook, webhookRoute.runtime],
    ['ingest/review', ingest, ingestRoute.runtime],
  ])('POST /api/%s is a 501 stub on the node runtime', async (_name, handler, runtime) => {
    const res = handler();
    expect(res.status).toBe(501);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_implemented');
    expect(runtime).toBe('nodejs');
  });
});

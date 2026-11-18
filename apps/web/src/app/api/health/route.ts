import type { HealthResponse } from '@app/shared';
import type { z } from 'zod';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const body: z.infer<typeof HealthResponse> = { ok: true };
  return Response.json(body);
}

import { errorBody } from '@app/shared';

export const runtime = 'nodejs';

// Stub — lane D replaces this with the ingest handler from '@/server/ingest'.
export function POST(): Response {
  return Response.json(errorBody('not_implemented', 'Review ingest is not implemented yet'), {
    status: 501,
  });
}

import { errorBody } from '@app/shared';

export const runtime = 'nodejs';

// Stub — lane A replaces this with HMAC verification + dispatch to '@/server/github'.
export function POST(): Response {
  return Response.json(errorBody('not_implemented', 'GitHub webhooks are not implemented yet'), {
    status: 501,
  });
}

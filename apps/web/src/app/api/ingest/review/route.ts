import { handleIngestReview } from '@/server/ingest';

export const runtime = 'nodejs';

/** Results from the user's Claude / Codex GitHub Action (Bearer rit_… ingest token). */
export async function POST(req: Request): Promise<Response> {
  return handleIngestReview(req);
}

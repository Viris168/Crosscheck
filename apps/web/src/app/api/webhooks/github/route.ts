import { handleGithubWebhook } from '@/server/github';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  return handleGithubWebhook(req);
}

import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/server/auth';

// Better Auth handles every /api/auth/* route (sign-in, callback, session, organization, …).
export const { GET, POST } = toNextJsHandler((req: Request) => auth.handler(req));

import { serve } from 'inngest/next';
import { functions, inngest } from '@/server/jobs';

// Inngest calls this endpoint to discover and run functions (signed with INNGEST_SIGNING_KEY).
export const { GET, POST, PUT } = serve({ client: inngest, functions });

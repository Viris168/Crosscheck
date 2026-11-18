import { eventSchemas } from '@app/shared';
import { EventSchemas, Inngest } from 'inngest';

// Event key, signing key, base URL and dev mode come from INNGEST_* env vars (read by the SDK).
// `fromSchema` takes Standard Schema (zod v4); `fromZod` in inngest v3 only types zod v3.
export const inngest = new Inngest({
  id: 'ai-review',
  schemas: new EventSchemas().fromSchema(eventSchemas),
});

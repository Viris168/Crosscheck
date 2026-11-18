import { z } from 'zod';
import { Id, IsoDate } from './common';

/** GET /api/oauth/chatgpt/callback?code&state (redirects back to the dashboard). */
export const ChatGptCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

/** GET /api/connections/chatgpt — the current user's connection in the active org. Never returns tokens. */
export const GetChatGptConnectionResponse = z.object({
  connected: z.boolean(),
  orgId: Id.nullable(),
  connectedAt: IsoDate.nullish(),
  expiresAt: IsoDate.nullish(),
});
export type ChatGptConnection = z.infer<typeof GetChatGptConnectionResponse>;

/** DELETE /api/connections/chatgpt */
export const DeleteChatGptConnectionResponse = z.object({ ok: z.literal(true) });

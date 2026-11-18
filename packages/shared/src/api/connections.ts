import { z } from 'zod';

/** GET /api/oauth/chatgpt/callback?code&state (redirects back to the dashboard). */
export const ChatGptCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

/** DELETE /api/connections/chatgpt */
export const DeleteChatGptConnectionResponse = z.object({ ok: z.literal(true) });

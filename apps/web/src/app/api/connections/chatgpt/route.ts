import { prisma } from '@app/db';
import { DeleteChatGptConnectionResponse } from '@app/shared';
import { json, route } from '@/lib/server/http';
import { resolveCurrentOrgId } from '@/lib/server/org';
import { GetChatGptConnectionResponse } from '@/lib/pending-contracts';
import { requireOrgMember, requireSession } from '@/server/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/connections/chatgpt — the current user's ChatGPT connection in the current org.
 * Pending contract (tasks/CONTRACT_REQUESTS.md); the schema lives in `@/lib/pending-contracts`.
 */
export const GET = route(async (req) => {
  const session = await requireSession(req);
  const orgId = await resolveCurrentOrgId(session);
  if (!orgId) return json(GetChatGptConnectionResponse, { connected: false, orgId: null });
  await requireOrgMember(session.user.id, orgId);

  const cred = await prisma.providerCredential.findUnique({
    where: {
      orgId_userId_provider: { orgId, userId: session.user.id, provider: 'codex_chatgpt' },
    },
    select: { createdAt: true, expiresAt: true },
  });
  return json(GetChatGptConnectionResponse, {
    connected: cred != null,
    orgId,
    connectedAt: cred?.createdAt.toISOString() ?? null,
    expiresAt: cred?.expiresAt?.toISOString() ?? null,
  });
});

/** DELETE /api/connections/chatgpt — removes the stored (encrypted) tokens. */
export const DELETE = route(async (req) => {
  const session = await requireSession(req);
  const orgId = await resolveCurrentOrgId(session);
  if (orgId) {
    await requireOrgMember(session.user.id, orgId);
    await prisma.providerCredential.deleteMany({
      where: { orgId, userId: session.user.id, provider: 'codex_chatgpt' },
    });
  }
  return json(DeleteChatGptConnectionResponse, { ok: true });
});

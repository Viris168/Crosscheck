import type { ProviderContext } from '@app/shared';

/** A `ProviderCredential` row (tokens still encrypted). */
export interface StoredCredential {
  id: string;
  encryptedToken: string;
  encryptedRefreshToken: string | null;
  expiresAt: Date | null;
}

export interface CredentialStore {
  /** The org's `codex_chatgpt` credential (for `ctx.userId` when given, else the most recently updated). */
  load(ctx: ProviderContext): Promise<StoredCredential | null>;
  save(
    id: string,
    data: { encryptedToken: string; encryptedRefreshToken: string | null; expiresAt: Date | null },
  ): Promise<void>;
}

/** Looks up `repo.settings.model` for a repo (by org + full name). */
export type RepoModelLookup = (orgId: string, repoFullName: string) => Promise<string | undefined>;

// `@app/db` is imported lazily so that importing this package (and its unit tests) never constructs a
// PrismaClient. Only the default stores touch the database.
async function db() {
  const mod = await import('@app/db');
  return mod.prisma;
}

export const prismaCredentialStore: CredentialStore = {
  async load(ctx) {
    const prisma = await db();
    return prisma.providerCredential.findFirst({
      where: {
        orgId: ctx.orgId,
        provider: 'codex_chatgpt',
        ...(ctx.userId ? { userId: ctx.userId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, encryptedToken: true, encryptedRefreshToken: true, expiresAt: true },
    });
  },
  async save(id, data) {
    const prisma = await db();
    await prisma.providerCredential.update({ where: { id }, data });
  },
};

export const prismaRepoModelLookup: RepoModelLookup = async (orgId, repoFullName) => {
  const prisma = await db();
  const repo = await prisma.repo.findFirst({
    where: { orgId, fullName: repoFullName },
    select: { settings: true },
  });
  const settings = repo?.settings;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const model = (settings as Record<string, unknown>).model;
    if (typeof model === 'string' && model.trim() !== '') return model.trim();
  }
  return undefined;
};

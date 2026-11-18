// In-memory stand-in for the slice of PrismaClient that lane A uses. Test-only.
// Implements only the query shapes our handlers send; anything else throws so gaps are obvious.

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

let seq = 0;
const cuid = (p: string) => `${p}_${++seq}`;

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

export function createFakeDb() {
  const t = {
    organization: [] as Row[],
    account: [] as Row[],
    member: [] as Row[],
    installation: [] as Row[],
    repo: [] as Row[],
    pullRequest: [] as Row[],
    review: [] as Row[],
  };

  const now = () => new Date();

  const db = {
    organization: {
      findFirst: async ({ where }: any) => {
        const want = String(where.githubAccountLogin.equals).toLowerCase();
        return t.organization.find((o) => o.githubAccountLogin?.toLowerCase() === want) ?? null;
      },
      findUnique: async ({ where }: any) =>
        t.organization.find((o) => o.slug === where.slug) ?? null,
      create: async ({ data }: any) => {
        if (t.organization.some((o) => o.slug === data.slug)) throw uniqueViolation();
        const row = { createdAt: now(), plan: 'free', ...data };
        t.organization.push(row);
        return row;
      },
    },
    account: {
      findFirst: async ({ where }: any) =>
        t.account.find(
          (a) => a.providerId === where.providerId && a.accountId === where.accountId,
        ) ?? null,
    },
    member: {
      count: async ({ where }: any) =>
        t.member.filter((m) => m.organizationId === where.organizationId).length,
      upsert: async ({ where, create }: any) => {
        const k = where.organizationId_userId;
        const hit = t.member.find(
          (m) => m.organizationId === k.organizationId && m.userId === k.userId,
        );
        if (hit) return hit;
        const row = { createdAt: now(), ...create };
        t.member.push(row);
        return row;
      },
    },
    installation: {
      upsert: async ({ where, create, update }: any) => {
        const hit = t.installation.find(
          (i) => i.githubInstallationId === where.githubInstallationId,
        );
        if (hit) return Object.assign(hit, update, { updatedAt: now() });
        const row = { id: cuid('inst'), createdAt: now(), updatedAt: now(), ...create };
        t.installation.push(row);
        return row;
      },
    },
    repo: {
      findUnique: async ({ where }: any) =>
        t.repo.find((r) => r.githubRepoId === where.githubRepoId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const hit = t.repo.find((r) => r.githubRepoId === where.githubRepoId);
        if (hit) return Object.assign(hit, update, { updatedAt: now() });
        const row = { id: cuid('repo'), createdAt: now(), updatedAt: now(), ...create };
        t.repo.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let match: (r: Row) => boolean;
        if (where.installation) {
          const inst = t.installation.find(
            (i) => i.githubInstallationId === where.installation.githubInstallationId,
          );
          match = (r) => !!inst && r.installationId === inst.id;
        } else if (where.githubRepoId?.in) {
          match = (r) => where.githubRepoId.in.includes(r.githubRepoId);
        } else {
          throw new Error(`fake repo.updateMany: unsupported where ${JSON.stringify(where)}`);
        }
        const rows = t.repo.filter(match);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    pullRequest: {
      findUnique: async ({ where }: any) => {
        const k = where.repoId_number;
        return t.pullRequest.find((p) => p.repoId === k.repoId && p.number === k.number) ?? null;
      },
      upsert: async ({ where, create, update }: any) => {
        const k = where.repoId_number;
        const hit = t.pullRequest.find((p) => p.repoId === k.repoId && p.number === k.number);
        if (hit) return Object.assign(hit, update, { updatedAt: now() });
        const row = { id: cuid('pr'), createdAt: now(), updatedAt: now(), ...create };
        t.pullRequest.push(row);
        return row;
      },
    },
    review: {
      create: async ({ data }: any) => {
        const dup = t.review.some(
          (r) =>
            r.pullRequestId === data.pullRequestId &&
            r.headSha === data.headSha &&
            r.provider === data.provider,
        );
        if (dup) throw uniqueViolation();
        const row = { id: cuid('rev'), createdAt: now(), updatedAt: now(), ...data };
        t.review.push(row);
        return row;
      },
      delete: async ({ where }: any) => {
        const i = t.review.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error('not found');
        return t.review.splice(i, 1)[0];
      },
    },
  };

  return { db, tables: t };
}

export type FakeDb = ReturnType<typeof createFakeDb>;

import { prisma } from '@app/db';
import {
  HttpError,
  SetCompareWithBody,
  SetCompareWithResponse,
  TreeParams,
  TreeSnapshotSchema,
} from '@app/shared';
import { requireRepoWrite } from '@/lib/server/access';
import { json, readJson, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';
import { applyOverrides, createsLoop } from '../apply-overrides';
import { automaticIfNeeded, loadOverrides } from '../overrides';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/repos/:repoId/tree/compare-with — set (or clear, `compareWith: null`) which branch a branch is
 * compared with. Write access. Returns the branch recomputed on the stored graph, no sync needed.
 */
export const PUT = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = TreeParams.parse(params);
  await requireRepoWrite(session.user.id, repoId);
  const { branch, compareWith } = SetCompareWithBody.parse(await readJson(req));

  if (compareWith === branch)
    throw new HttpError('bad_request', 'A branch cannot be compared with itself.');
  const rows = await prisma.branch.findMany({
    where: {
      repoId,
      deletedAt: null,
      name: { in: compareWith ? [branch, compareWith] : [branch] },
    },
    select: { name: true, isDefault: true },
  });
  const row = rows.find((r) => r.name === branch);
  if (!row) throw new HttpError('bad_request', 'Unknown branch.');
  if (row.isDefault)
    throw new HttpError('bad_request', 'The default branch is not compared with anything.');
  if (compareWith && !rows.some((r) => r.name === compareWith))
    throw new HttpError('bad_request', 'Unknown branch to compare with.');

  const graph = await prisma.repoGraph.findUnique({
    where: { repoId },
    select: { snapshot: true },
  });
  const parsed = graph?.snapshot == null ? null : TreeSnapshotSchema.safeParse(graph.snapshot);
  if (!parsed?.success) throw new HttpError('conflict', 'The branch tree is not ready yet.');
  const snapshot = parsed.data;
  const inTree = new Set(snapshot.branches.map((b) => b.name));
  if (!inTree.has(branch) || (compareWith && !inTree.has(compareWith)))
    throw new HttpError(
      'conflict',
      'The branch tree has not seen this branch yet. Refresh it first.',
    );

  const current = await loadOverrides(repoId);
  const next: Record<string, string> = { ...current };
  if (compareWith) next[branch] = compareWith;
  else delete next[branch];

  const [autoBefore, autoAfter] = await Promise.all([
    automaticIfNeeded(repoId, snapshot, current),
    automaticIfNeeded(repoId, snapshot, next),
  ]);
  if (compareWith && createsLoop(snapshot, next, branch, autoAfter))
    throw new HttpError(
      'bad_request',
      'That would make a loop: the other branch is already compared with this one.',
    );

  const before = applyOverrides(snapshot, current, autoBefore).branches.find(
    (b) => b.name === branch,
  )!;
  if (compareWith) {
    await prisma.compareOverride.upsert({
      where: { repoId_branchName: { repoId, branchName: branch } },
      create: { repoId, branchName: branch, compareWith, setByUserId: session.user.id },
      update: { compareWith, setByUserId: session.user.id },
    });
  } else {
    await prisma.compareOverride.deleteMany({ where: { repoId, branchName: branch } });
  }
  // No branch names: the team only needs to see which rule picked wrong.
  logger.info(
    { repoId, whyBefore: before.why, cleared: compareWith === null },
    'compare-with override',
  );

  const after = applyOverrides(snapshot, next, autoAfter).branches.find((b) => b.name === branch)!;
  return json(SetCompareWithResponse, { branch: after });
});

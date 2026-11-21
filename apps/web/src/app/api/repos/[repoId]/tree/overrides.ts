// DB reads for compare-with overrides. The math lives in ./apply-overrides (pure).
import { prisma } from '@app/db';
import type { TreeSnapshot } from '@app/shared';
import {
  applyOverrides,
  clearedBranches,
  type AutomaticInputs,
  type Overrides,
} from './apply-overrides';

export async function loadOverrides(repoId: string): Promise<Record<string, string>> {
  const rows = await prisma.compareOverride.findMany({
    where: { repoId },
    select: { branchName: true, compareWith: true },
  });
  return Object.fromEntries(rows.map((r) => [r.branchName, r.compareWith]));
}

/** PR records + recorded parents, as the sync job passes them to the engine. */
export async function loadAutomaticInputs(repoId: string): Promise<AutomaticInputs> {
  const [prs, branches] = await Promise.all([
    prisma.pullRequest.findMany({
      where: { repoId },
      select: { number: true, headRef: true, baseRef: true, state: true, headSha: true },
    }),
    prisma.branch.findMany({
      where: { repoId, deletedAt: null },
      select: { name: true, recordedParents: true },
    }),
  ]);
  return {
    prs: prs.map((p) => ({ ...p, mergeMethod: null })),
    recordedParents: Object.fromEntries(branches.map((b) => [b.name, b.recordedParents])),
  };
}

/** Automatic-rule inputs, read only when some branch lost its override since the snapshot was built. */
export async function automaticIfNeeded(
  repoId: string,
  snapshot: TreeSnapshot,
  overrides: Overrides,
): Promise<AutomaticInputs | null> {
  return clearedBranches(snapshot, overrides).length ? loadAutomaticInputs(repoId) : null;
}

/** The stored snapshot with the current overrides applied. */
export async function withOverrides(
  repoId: string,
  snapshot: TreeSnapshot,
  overrides?: Overrides,
): Promise<TreeSnapshot> {
  const o = overrides ?? (await loadOverrides(repoId));
  return applyOverrides(snapshot, o, await automaticIfNeeded(repoId, snapshot, o));
}

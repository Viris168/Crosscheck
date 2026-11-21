'use client';

import type { BranchNode, TreeSnapshot } from '@app/shared/client';
import { Alert } from '@/components/ui/alert';
import { Select } from '@/components/ui/input';
import { useSetCompareWith } from '@/hooks/use-tree';
import { ApiError } from '@/lib/api-client';

/**
 * Prototype `#fBase`: "Automatic (PR target, record or guess)" + every other branch. Only shown with
 * write access (`canEdit`) and never for the default branch.
 */
export function CompareWithSelect({
  repoId,
  snapshot,
  branch,
}: {
  repoId: string;
  snapshot: TreeSnapshot;
  branch: BranchNode;
}) {
  const set = useSetCompareWith(repoId);
  const targets = snapshot.branches.map((b) => b.name).filter((n) => n !== branch.name);
  const value = branch.why === 'override' && branch.compareWith ? branch.compareWith : '';
  const error =
    set.error instanceof ApiError && set.error.status === 400
      ? set.error.message
      : set.error
        ? 'Could not change what this branch is compared with. Try again.'
        : null;

  return (
    <div className="mt-4 border-t pt-3">
      <h3 className="mb-2 text-sm font-semibold">Compare with</h3>
      <Select
        aria-label={`Compare ${branch.name} with`}
        value={value}
        disabled={set.isPending}
        onChange={(e) => set.mutate({ branch: branch.name, compareWith: e.target.value || null })}
      >
        <option value="">Automatic (PR target, record or guess)</option>
        {targets.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      {error && (
        <Alert tone="error" className="mt-2">
          {error}
        </Alert>
      )}
    </div>
  );
}

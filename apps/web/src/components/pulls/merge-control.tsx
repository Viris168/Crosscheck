'use client';

import type { MergeMethod, ReviewDetail, ReviewSummary } from '@app/shared/client';
import { GitMerge } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label, Select } from '@/components/ui/input';
import { useMergePull } from '@/hooks/use-pulls';
import { useReview } from '@/hooks/use-reviews';
import { ApiError } from '@/lib/api-client';
import { PROVIDER_LABEL } from '@/lib/labels';

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

/**
 * The review a merge relies on: the newest completed review of the latest commit. A newer
 * re-run (say, a second opinion from another provider) that is still waiting or failed does
 * not take it back. `reviews` is the PR's history, newest first.
 */
export function mergeableReview(
  latest: ReviewDetail | null,
  reviews: ReviewSummary[] = [],
): Pick<ReviewSummary, 'id' | 'provider'> | null {
  if (latest && latest.status === 'completed' && !latest.stale) return latest;
  return reviews.find((r) => r.status === 'completed' && !r.stale) ?? null;
}

/** Why the PR can't be merged from here yet, or null when it can. */
export function mergeBlocker(
  review: ReviewDetail | null,
  reviews: ReviewSummary[] = [],
): string | null {
  if (mergeableReview(review, reviews)) return null;
  if (!review) return 'Merge needs a review first.';
  if (review.stale) return 'Merge needs a review of the latest commit.';
  if (review.status !== 'completed') return 'Merge is available once the review completes.';
  return null;
}

/**
 * Merge button for an open PR. Asks for confirmation (and the merge method) before merging;
 * high / critical risk is called out in the confirmation.
 */
export function MergeControl({
  repoId,
  number,
  review,
  reviews = [],
}: {
  repoId: string;
  number: number;
  review: ReviewDetail | null;
  /** The PR's review history, newest first. */
  reviews?: ReviewSummary[];
}) {
  const merge = useMergePull(repoId, number);
  const [confirming, setConfirming] = useState(false);
  const [method, setMethod] = useState<MergeMethod>('merge');
  const blocker = mergeBlocker(review, reviews);
  const basis = mergeableReview(review, reviews);
  // When the merge rests on an older review than the one shown, load it for its risk level.
  const older = useReview(basis && basis.id !== review?.id ? basis.id : null);
  const basisDetail = basis?.id === review?.id ? review : (older.data ?? null);
  const risky = basisDetail?.risk?.level === 'high' || basisDetail?.risk?.level === 'critical';

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" disabled={!!blocker} onClick={() => setConfirming(true)}>
          <GitMerge aria-hidden /> Merge
        </Button>
        {blocker && <p className="text-xs text-muted-foreground">{blocker}</p>}
        {!blocker && basis && basis.id !== review?.id && (
          <p className="text-xs text-muted-foreground">
            Based on the completed {PROVIDER_LABEL[basis.provider]} review.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border p-3">
      {risky && (
        <Alert tone="warning">
          The review rated this pull request {basisDetail?.risk?.level} risk. Check the findings
          before merging.
        </Alert>
      )}
      {merge.error && (
        <Alert tone="error">
          {merge.error instanceof ApiError
            ? merge.error.message
            : 'Something went wrong. Try again.'}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="merge-method" className="sr-only">
          Merge method
        </Label>
        <Select
          id="merge-method"
          value={method}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
          className="w-auto"
        >
          {(Object.keys(METHOD_LABEL) as MergeMethod[]).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={merge.isPending} onClick={() => merge.mutate(method)}>
          <GitMerge aria-hidden /> {merge.isPending ? 'Merging…' : 'Confirm merge'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={merge.isPending}
          onClick={() => {
            merge.reset();
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

'use client';

import type { ReviewDetail } from '@app/shared/client';
import { Alert } from '@/components/ui/alert';
import { useRerunReview, useRetryReview } from '@/hooks/use-reviews';
import { ApiError } from '@/lib/api-client';
import {
  ReviewCompleted,
  ReviewFailed,
  ReviewQueued,
  ReviewRunning,
  ReviewWaitingAction,
  type ReviewActions,
  type ReviewContext,
} from './review-states';

/** Renders one review in the component for its state, wired to retry / re-run. */
export function ReviewPanel({
  review,
  ctx,
  onStarted,
}: {
  review: ReviewDetail;
  ctx: ReviewContext;
  /** Called with the id of the review that a retry / re-run started. */
  onStarted?: (reviewId: string) => void;
}) {
  const retry = useRetryReview(ctx.repoId);
  const rerun = useRerunReview(ctx.repoId, ctx.prNumber);
  const actions: ReviewActions = {
    onRetry: () => retry.mutate(review.id, { onSuccess: (r) => onStarted?.(r.reviewId) }),
    onRerun: (provider) => rerun.mutate(provider, { onSuccess: (r) => onStarted?.(r.reviewId) }),
    pending: retry.isPending || rerun.isPending,
  };
  const error = retry.error ?? rerun.error;

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert tone="error">
          {error instanceof ApiError ? error.message : 'Something went wrong. Try again.'}
        </Alert>
      )}
      <ReviewState review={review} ctx={ctx} actions={actions} />
    </div>
  );
}

export function ReviewState({
  review,
  ctx,
  actions,
}: {
  review: ReviewDetail;
  ctx: ReviewContext;
  actions: ReviewActions;
}) {
  switch (review.status) {
    case 'queued':
      return <ReviewQueued review={review} ctx={ctx} />;
    case 'running':
      return <ReviewRunning review={review} ctx={ctx} />;
    case 'waiting_action':
      return <ReviewWaitingAction review={review} ctx={ctx} />;
    case 'completed':
      return <ReviewCompleted review={review} ctx={ctx} actions={actions} />;
    case 'failed':
      return <ReviewFailed review={review} ctx={ctx} actions={actions} />;
  }
}

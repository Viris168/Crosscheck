'use client';

import type { ReviewDetail } from '@app/shared/client';
import { Alert } from '@/components/ui/alert';
import { useChatGptConnection } from '@/hooks/use-connections';
import { useCancelReview, useRerunReview, useRetryReview } from '@/hooks/use-reviews';
import { ApiError } from '@/lib/api-client';
import {
  ReviewCancelled,
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
  const cancel = useCancelReview(ctx.repoId);
  const chatgpt = useChatGptConnection();
  const actions: ReviewActions = {
    onRetry: () => retry.mutate(review.id, { onSuccess: (r) => onStarted?.(r.reviewId) }),
    onCancel: () => cancel.mutate(review.id),
    onRerun: (provider) => rerun.mutate(provider, { onSuccess: (r) => onStarted?.(r.reviewId) }),
    onSwitch: (provider) =>
      cancel.mutate(review.id, {
        onSuccess: () => rerun.mutate(provider, { onSuccess: (r) => onStarted?.(r.reviewId) }),
      }),
    pending: retry.isPending || rerun.isPending || cancel.isPending,
    chatgptConnected: chatgpt.data?.connected ?? false,
  };
  const error = retry.error ?? rerun.error ?? cancel.error;

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
      return <ReviewQueued review={review} ctx={ctx} actions={actions} />;
    case 'running':
      return <ReviewRunning review={review} ctx={ctx} />;
    case 'waiting_action':
      return <ReviewWaitingAction review={review} ctx={ctx} actions={actions} />;
    case 'completed':
      return <ReviewCompleted review={review} ctx={ctx} actions={actions} />;
    case 'failed':
      return <ReviewFailed review={review} ctx={ctx} actions={actions} />;
    case 'cancelled':
      return <ReviewCancelled review={review} ctx={ctx} actions={actions} />;
  }
}

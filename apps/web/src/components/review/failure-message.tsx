import type { ReviewDetail } from '@app/shared/client';
import type { ReactNode } from 'react';

export interface FailureContext {
  repoFullName: string;
}

/** User-facing message for a failed (or partially reviewed) review, by `errorCode`. */
export function failureMessage(
  review: Pick<ReviewDetail, 'id' | 'errorCode' | 'provider' | 'filesTotal'>,
  ctx: FailureContext,
): ReactNode {
  switch (review.errorCode) {
    case 'too_large':
      return `This PR is very large (${review.filesTotal} files). We reviewed the riskiest files first.`;
    case 'provider_auth':
      if (review.provider === 'claude_action') {
        return (
          <>
            Your Claude token expired — run <code>claude setup-token</code> and update the{' '}
            <code>CLAUDE_CODE_OAUTH_TOKEN</code> secret.
          </>
        );
      }
      if (review.provider === 'codex_chatgpt') return 'Reconnect ChatGPT.';
      if (review.provider === 'codex_action') {
        return (
          <>
            Your OpenAI key was rejected — update the <code>OPENAI_API_KEY</code> secret.
          </>
        );
      }
      return <OurSide id={review.id} />;
    case 'rate_limited':
      return "Your plan's usage limit was reached. Retry later or switch provider.";
    case 'timeout':
      return 'The review took too long.';
    case 'action_missing':
      return (
        <>
          Your GitHub Action didn&apos;t send a result.{' '}
          <a
            className="font-medium underline underline-offset-2"
            href={`https://github.com/${ctx.repoFullName}/actions`}
            target="_blank"
            rel="noreferrer"
          >
            View workflow runs
          </a>
        </>
      );
    case 'invalid_output':
      return 'The AI returned an invalid result.';
    case 'github_error':
    case 'internal':
    default:
      return <OurSide id={review.id} />;
  }
}

function OurSide({ id }: { id: string }) {
  return (
    <>
      Something went wrong on our side. Review id: <code>{id}</code>
    </>
  );
}

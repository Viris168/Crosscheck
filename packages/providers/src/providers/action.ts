import { ProviderError, type ReviewProvider } from '@app/shared';

/** `claude_action` / `codex_action`: reviews run in the user's GitHub Action and arrive via ingest. */
export function createActionProvider(id: 'claude_action' | 'codex_action'): ReviewProvider {
  return {
    id,
    runsInWorker: false,
    async reviewChunk() {
      throw new ProviderError(
        'internal',
        `${id} runs in the user's GitHub Action; results arrive via /api/ingest/review`,
      );
    },
  };
}

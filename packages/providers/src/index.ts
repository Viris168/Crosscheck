import type { ProviderId, ReviewProvider } from '@app/shared';
import { createActionProvider } from './providers/action';
import { createCodexChatgptProvider } from './providers/codex-chatgpt';
import { mockProvider, type MockProvider } from './providers/mock';
import { createPlatformProvider } from './providers/platform';

export { buildReviewPrompt, buildActionPrompt, annotatePatch } from './prompt';
export { ACTION_PROMPT_PLACEHOLDERS, ACTION_OUTPUT_FILE } from './prompt';
export { parseModelOutput, ChunkResultSchema } from './parse';
export {
  chatgptOAuth,
  createChatgptOAuth,
  createPkcePair,
  CHATGPT_SCOPES,
  type ChatGptOAuth,
  type ChatGptTokens,
} from './chatgpt-oauth';
export { toProviderError, codeForStatus } from './errors';
export type { CredentialStore, StoredCredential, RepoModelLookup } from './credentials';
export {
  createPlatformProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from './providers/platform';
export { createCodexChatgptProvider, DEFAULT_CHATGPT_MODEL } from './providers/codex-chatgpt';
export { createActionProvider } from './providers/action';
export { mockProvider, mockReview, type MockProvider } from './providers/mock';

const cache = new Map<ProviderId, ReviewProvider>();

function create(id: ProviderId): ReviewProvider {
  switch (id) {
    case 'platform':
      return createPlatformProvider();
    case 'codex_chatgpt':
      return createCodexChatgptProvider();
    case 'claude_action':
    case 'codex_action':
      return createActionProvider(id);
  }
}

/** Provider for a repo's `provider` setting. `'mock'` (tests only) returns a deterministic fixture provider. */
export function getProvider(id: ProviderId): ReviewProvider;
export function getProvider(id: 'mock'): MockProvider;
export function getProvider(id: ProviderId | 'mock'): ReviewProvider | MockProvider {
  if (id === 'mock') return mockProvider;
  let p = cache.get(id);
  if (!p) {
    p = create(id);
    cache.set(id, p);
  }
  return p;
}

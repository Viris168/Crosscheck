import {
  ProviderError,
  decrypt,
  encrypt,
  type ProviderContext,
  type ReviewChunkInput,
  type ReviewProvider,
} from '@app/shared';
import { createChatgptOAuth, type ChatGptOAuth } from '../chatgpt-oauth';
import { prismaCredentialStore, type CredentialStore } from '../credentials';
import { reviewWithOpenAI } from './platform';

// VERIFY: model and inference endpoint for plan-usage tokens. OpenAI's SIWC docs say the token is for
// "Responses API access"; we call https://api.openai.com/v1/responses with it as a Bearer token.
export const DEFAULT_CHATGPT_MODEL = 'gpt-5-codex';

/** Refresh this long before `expiresAt` so the token cannot expire mid-call. */
const EXPIRY_SKEW_MS = 2 * 60_000;

export interface CodexChatgptDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  store?: CredentialStore;
  oauth?: ChatGptOAuth;
  now?: () => Date;
  /** Override for tests; defaults to `ENCRYPTION_KEY`. */
  encryptionKey?: Buffer;
}

export function createCodexChatgptProvider(deps: CodexChatgptDeps = {}): ReviewProvider {
  const store = deps.store ?? prismaCredentialStore;
  const now = () => (deps.now ? deps.now() : new Date());
  const enc = (s: string) => encrypt(s, deps.encryptionKey);
  const dec = (s: string) => decrypt(s, deps.encryptionKey);

  async function accessToken(ctx: ProviderContext): Promise<string> {
    const cred = await store.load(ctx);
    if (!cred) throw new ProviderError('provider_auth', 'codex_chatgpt: ChatGPT is not connected');

    let token: string;
    try {
      token = dec(cred.encryptedToken);
    } catch {
      throw new ProviderError(
        'provider_auth',
        'codex_chatgpt: stored credential cannot be decrypted',
      );
    }

    const expired = cred.expiresAt && cred.expiresAt.getTime() - EXPIRY_SKEW_MS <= now().getTime();
    if (!expired) return token;

    if (!cred.encryptedRefreshToken) {
      throw new ProviderError('provider_auth', 'codex_chatgpt: token expired and no refresh token');
    }
    let refreshToken: string;
    try {
      refreshToken = dec(cred.encryptedRefreshToken);
    } catch {
      throw new ProviderError(
        'provider_auth',
        'codex_chatgpt: stored credential cannot be decrypted',
      );
    }
    const oauth = deps.oauth ?? createChatgptOAuth({ env: deps.env, fetch: deps.fetch, now });
    const fresh = await oauth.refresh(refreshToken);
    await store.save(cred.id, {
      encryptedToken: enc(fresh.accessToken),
      // Refresh tokens rotate: keep the new one, or the old one if none was returned.
      encryptedRefreshToken: fresh.refreshToken
        ? enc(fresh.refreshToken)
        : cred.encryptedRefreshToken,
      expiresAt: fresh.expiresAt ?? null,
    });
    return fresh.accessToken;
  }

  return {
    id: 'codex_chatgpt',
    runsInWorker: true,
    async reviewChunk(input: ReviewChunkInput, ctx: ProviderContext) {
      const env = deps.env ?? process.env;
      const token = await accessToken(ctx);
      return reviewWithOpenAI(input, {
        apiKey: token,
        model: env.CHATGPT_MODEL ?? DEFAULT_CHATGPT_MODEL,
        fetch: deps.fetch,
        label: 'codex_chatgpt',
      });
    },
  };
}

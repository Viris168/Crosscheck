import { createHash, randomBytes } from 'node:crypto';
import { LIMITS, ProviderError } from '@app/shared';
import { codeForStatus, toProviderError } from './errors';

// VERIFY: endpoints, scopes and `resource` come from developers.openai.com/siwc (token-sharing sign-in guide,
// checked 2026-11-18). That guide documents the open-source (loopback, public client) flow; a hosted web app
// with a client secret may get a different registration. Confirm with OpenAI before launch.
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
/** `chatgpt.tokens.use.direct` = plan-usage scope; the access token is only usable for inference with it. */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_PLAN_SCOPE,
] as const;

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  /** Scopes actually granted (when the token endpoint reports them). */
  scopes?: string[];
}

export interface ChatGptOAuthDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** PKCE pair. Store `verifier` server-side (e.g. httpOnly cookie next to `state`) between start and callback. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  scopes?: unknown;
  error?: unknown;
}

function parseScopes(body: TokenResponse): string[] | undefined {
  if (typeof body.scope === 'string') return body.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(body.scopes))
    return body.scopes.filter((s): s is string => typeof s === 'string');
  return undefined;
}

export function createChatgptOAuth(deps: ChatGptOAuthDeps = {}) {
  const env = () => deps.env ?? process.env;
  const now = () => (deps.now ? deps.now() : new Date());
  const clientId = () => {
    const id = env().CHATGPT_OAUTH_CLIENT_ID;
    if (!id) throw new ProviderError('provider_auth', 'CHATGPT_OAUTH_CLIENT_ID is not set');
    return id;
  };

  async function tokenRequest(form: Record<string, string>): Promise<ChatGptTokens> {
    const body = new URLSearchParams({ client_id: clientId(), ...form });
    // VERIFY: the guide says the public client needs no secret; we send it when configured.
    const secret = env().CHATGPT_OAUTH_CLIENT_SECRET;
    if (secret) body.set('client_secret', secret);

    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(CHATGPT_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(LIMITS.providerCallTimeoutMs),
      });
    } catch (err) {
      throw toProviderError(err, 'chatgpt-oauth');
    }

    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok) {
      // invalid_grant (expired / revoked / reused code or refresh token) → user must reconnect.
      const code = json.error === 'invalid_grant' ? 'provider_auth' : codeForStatus(res.status);
      throw new ProviderError(code, `chatgpt-oauth: token endpoint HTTP ${res.status}`);
    }
    if (typeof json.access_token !== 'string' || json.access_token === '') {
      throw new ProviderError('provider_auth', 'chatgpt-oauth: token response has no access_token');
    }
    const scopes = parseScopes(json);
    if (scopes && !scopes.includes(CHATGPT_PLAN_SCOPE)) {
      throw new ProviderError('provider_auth', 'chatgpt-oauth: ChatGPT plan usage was not granted');
    }
    return {
      accessToken: json.access_token,
      ...(typeof json.refresh_token === 'string' ? { refreshToken: json.refresh_token } : {}),
      ...(typeof json.expires_in === 'number'
        ? { expiresAt: new Date(now().getTime() + json.expires_in * 1000) }
        : {}),
      ...(scopes ? { scopes } : {}),
    };
  }

  return {
    /**
     * URL to redirect the user to. Pass `codeChallenge` from `createPkcePair()` (PKCE S256 is required by
     * OpenAI's guide) and a fresh `nonce`.
     */
    authorizeUrl(
      state: string,
      redirectUri: string,
      opts: { codeChallenge?: string; nonce?: string } = {},
    ): string {
      const url = new URL(CHATGPT_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId());
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', CHATGPT_SCOPES.join(' '));
      url.searchParams.set('resource', CHATGPT_RESOURCE);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', opts.nonce ?? randomBytes(16).toString('base64url'));
      if (opts.codeChallenge) {
        url.searchParams.set('code_challenge', opts.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },

    /** Exchange the callback `code`. Pass the PKCE `codeVerifier` stored at start. */
    exchangeCode(
      code: string,
      redirectUri: string,
      opts: { codeVerifier?: string } = {},
    ): Promise<ChatGptTokens> {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        resource: CHATGPT_RESOURCE,
        ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
      });
    },

    // VERIFY: standard RFC 6749 refresh_token grant; OpenAI's guide says refresh tokens rotate but does not
    // document the request. Always save the returned refresh token when present.
    refresh(refreshToken: string): Promise<ChatGptTokens> {
      return tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        resource: CHATGPT_RESOURCE,
      });
    },
  };
}

export type ChatGptOAuth = ReturnType<typeof createChatgptOAuth>;

/** Default instance; reads CHATGPT_OAUTH_CLIENT_ID / CHATGPT_OAUTH_CLIENT_SECRET from env at call time. */
export const chatgptOAuth: ChatGptOAuth = createChatgptOAuth();

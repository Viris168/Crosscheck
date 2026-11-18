import { ProviderError, type ErrorCode } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformProvider } from './providers/platform';
import {
  anthropicMessage,
  jsonResponse,
  openaiResponse,
  sampleInput,
  validResultJson,
} from './test-fixtures';

const ctx = { orgId: 'org_1' };
const noRepoModel = async () => undefined;

function provider(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-test' }) {
  return createPlatformProvider({ env, fetch: fetchImpl, repoModelLookup: noRepoModel });
}

async function codeOf(p: Promise<unknown>): Promise<ErrorCode> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return (e as ProviderError).code;
  }
  throw new Error('expected rejection');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('platform provider (Anthropic)', () => {
  it('returns a validated result with the model name', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, anthropicMessage(JSON.stringify(validResultJson))),
    );
    const res = await provider(fetchMock as unknown as typeof fetch).reviewChunk(sampleInput(), ctx);
    expect(res).toEqual({ ...validResultJson, model: 'claude-opus-5-5' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/v1/messages');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.system).toContain('chunk 1 of 2');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries inside the provider
  });

  it('uses repo settings model, then PLATFORM_MODEL', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, anthropicMessage(JSON.stringify(validResultJson))),
    );
    const p = createPlatformProvider({
      env: { ANTHROPIC_API_KEY: 'k', PLATFORM_MODEL: 'claude-sonnet-5-5' },
      fetch: fetchMock as unknown as typeof fetch,
      repoModelLookup: async () => 'claude-haiku-5-5',
    });
    await p.reviewChunk(sampleInput(), ctx);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).model).toBe('claude-haiku-5-5');
  });

  it.each([
    [401, 'provider_auth'],
    [403, 'provider_auth'],
    [429, 'rate_limited'],
    [529, 'rate_limited'],
    [504, 'timeout'],
    [500, 'internal'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(status, { type: 'error', error: { type: 'x', message: 'nope' } }),
    );
    expect(await codeOf(provider(fetchMock as unknown as typeof fetch).reviewChunk(sampleInput(), ctx))).toBe(code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a 90s timeout to timeout', async () => {
    vi.useFakeTimers();
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const pending = codeOf(provider(hang).reviewChunk(sampleInput(), ctx));
    await vi.advanceTimersByTimeAsync(91_000);
    expect(await pending).toBe('timeout');
  });

  it('maps unparseable output to invalid_output', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, anthropicMessage('LGTM!')));
    expect(await codeOf(provider(fetchMock as unknown as typeof fetch).reviewChunk(sampleInput(), ctx))).toBe(
      'invalid_output',
    );
  });

  it('maps a refusal to invalid_output', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, anthropicMessage('', { stop_reason: 'refusal', content: [] })),
    );
    expect(await codeOf(provider(fetchMock as unknown as typeof fetch).reviewChunk(sampleInput(), ctx))).toBe(
      'invalid_output',
    );
  });

  it('throws provider_auth when no key is configured', async () => {
    const fetchMock = vi.fn();
    expect(await codeOf(provider(fetchMock as unknown as typeof fetch, {}).reviewChunk(sampleInput(), ctx))).toBe(
      'provider_auth',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('platform provider (OpenAI fallback)', () => {
  const env = { OPENAI_API_KEY: 'sk-openai' };

  it('calls the Responses API when only OPENAI_API_KEY is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, openaiResponse(JSON.stringify(validResultJson))));
    const res = await provider(fetchMock as unknown as typeof fetch, env).reviewChunk(sampleInput(), ctx);
    expect(res).toEqual({ ...validResultJson, model: 'gpt-5' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('/responses');
  });

  it.each([
    [401, undefined, 'provider_auth'],
    [429, undefined, 'rate_limited'],
    [429, 'insufficient_quota', 'rate_limited'],
  ] as const)('maps HTTP %i (%s) to %s', async (status, errCode, code) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(status, { error: { message: 'x', type: 'x', code: errCode ?? null } }),
    );
    expect(await codeOf(provider(fetchMock as unknown as typeof fetch, env).reviewChunk(sampleInput(), ctx))).toBe(
      code,
    );
  });
});

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  LIMITS,
  ProviderError,
  type ProviderContext,
  type ReviewChunkInput,
  type ReviewChunkResult,
  type ReviewProvider,
} from '@app/shared';
import { prismaRepoModelLookup, type RepoModelLookup } from '../credentials';
import { toProviderError } from '../errors';
import { parseModelOutput } from '../parse';
import { buildReviewPrompt } from '../prompt';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
// VERIFY: default OpenAI model for the platform fallback; override with OPENAI_MODEL.
export const DEFAULT_OPENAI_MODEL = 'gpt-5';
const MAX_OUTPUT_TOKENS = 16_000;

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface PlatformProviderDeps {
  env?: NodeJS.ProcessEnv;
  /** Injected into both SDK clients (tests mock HTTP here). */
  fetch?: typeof fetch;
  repoModelLookup?: RepoModelLookup;
}

/** Text of the first text blocks in an Anthropic response. */
function anthropicText(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function reviewWithAnthropic(
  input: ReviewChunkInput,
  apiKey: string,
  model: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch | undefined,
): Promise<ReviewChunkResult> {
  const client = new Anthropic({
    apiKey,
    timeout: LIMITS.providerCallTimeoutMs,
    maxRetries: 0, // lane B's Inngest steps own retries
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const { system, user } = buildReviewPrompt(input);
  const effort = EFFORTS.includes(env.PLATFORM_EFFORT as Effort)
    ? (env.PLATFORM_EFFORT as Effort)
    : 'medium';

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort },
      // Server-side fallback: on a safety-classifier refusal the API re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    throw toProviderError(err, 'anthropic');
  }
  if (response.stop_reason === 'refusal') {
    throw new ProviderError('invalid_output', 'anthropic: model declined the request');
  }
  const result = parseModelOutput(anthropicText(response.content));
  return { ...result, model: response.model };
}

/** OpenAI Responses API call shared by the platform fallback and `codex_chatgpt`. */
export async function reviewWithOpenAI(
  input: ReviewChunkInput,
  opts: { apiKey: string; model: string; baseURL?: string; fetch?: typeof fetch; label: string },
): Promise<ReviewChunkResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    timeout: LIMITS.providerCallTimeoutMs,
    maxRetries: 0,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const { system, user } = buildReviewPrompt(input);
  let text: string;
  let model: string;
  try {
    const res = await client.responses.create({
      model: opts.model,
      instructions: system,
      input: user,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
    text = res.output_text;
    model = res.model;
  } catch (err) {
    throw toProviderError(err, opts.label);
  }
  const result = parseModelOutput(text);
  return { ...result, model };
}

export function createPlatformProvider(deps: PlatformProviderDeps = {}): ReviewProvider {
  const lookup = deps.repoModelLookup ?? prismaRepoModelLookup;
  return {
    id: 'platform',
    runsInWorker: true,
    async reviewChunk(input: ReviewChunkInput, ctx: ProviderContext) {
      const env = deps.env ?? process.env;
      let repoModel: string | undefined;
      try {
        repoModel = await lookup(ctx.orgId, input.repo);
      } catch {
        repoModel = undefined; // settings lookup is best-effort; fall back to env default
      }

      if (env.ANTHROPIC_API_KEY) {
        const model =
          (repoModel?.startsWith('claude') ? repoModel : undefined) ??
          env.PLATFORM_MODEL ??
          DEFAULT_ANTHROPIC_MODEL;
        return reviewWithAnthropic(input, env.ANTHROPIC_API_KEY, model, env, deps.fetch);
      }
      if (env.OPENAI_API_KEY) {
        const model =
          (repoModel && !repoModel.startsWith('claude') ? repoModel : undefined) ??
          env.OPENAI_MODEL ??
          DEFAULT_OPENAI_MODEL;
        return reviewWithOpenAI(input, {
          apiKey: env.OPENAI_API_KEY,
          model,
          fetch: deps.fetch,
          label: 'openai',
        });
      }
      throw new ProviderError(
        'provider_auth',
        'platform: neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set',
      );
    },
  };
}

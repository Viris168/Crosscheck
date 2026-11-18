import { ProviderError, ReviewResultSchema, type ReviewChunkResult } from '@app/shared';
import { z } from 'zod';

/** The part of `ReviewResult` (schema v1) a model returns for one chunk. Unknown keys are stripped. */
export const ChunkResultSchema = ReviewResultSchema.pick({
  risk_score: true,
  summary: true,
  issues: true,
  model: true,
});

/** Model output bigger than this is rejected without parsing. */
const MAX_OUTPUT_CHARS = 2_000_000;

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every balanced `{...}` substring, scanning from each `{` (string-aware). */
function* balancedObjects(text: string): Generator<string> {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Find the first JSON object in model text: whole text, then ```fences```, then any balanced object. */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const whole = tryParse(text.trim());
  if (isObject(whole)) return whole;

  const fence = /```[a-zA-Z]*\s*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) {
    const v = tryParse((m[1] ?? '').trim());
    if (isObject(v)) return v;
  }

  for (const candidate of balancedObjects(text)) {
    const v = tryParse(candidate);
    // Prefer something that looks like our result over e.g. an inline code example.
    if (isObject(v) && ('issues' in v || 'risk_score' in v)) return v;
  }
  return undefined;
}

/** Extract JSON from model text and validate it as a `ReviewChunkResult`. Throws `ProviderError('invalid_output')`. */
export function parseModelOutput(text: string): ReviewChunkResult {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ProviderError('invalid_output', 'Model returned empty output');
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    throw new ProviderError('invalid_output', 'Model output too large');
  }
  const json = extractJson(text);
  if (!json) throw new ProviderError('invalid_output', 'Model output contains no JSON object');

  const parsed = ChunkResultSchema.safeParse(json);
  if (!parsed.success) {
    // Only paths + zod messages; never echo model text.
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ProviderError('invalid_output', `Model output failed schema validation: ${where}`);
  }
  return parsed.data;
}

/** JSON Schema text of the chunk result, embedded in prompts. */
export function chunkResultJsonSchema(): string {
  return JSON.stringify(z.toJSONSchema(ChunkResultSchema.omit({ model: true })), null, 2);
}

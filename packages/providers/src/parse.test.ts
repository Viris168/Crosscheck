import { ProviderError } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { parseModelOutput } from './parse';
import { validResultJson } from './test-fixtures';

function expectInvalid(text: string) {
  try {
    parseModelOutput(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe('invalid_output');
    return;
  }
  throw new Error('expected parseModelOutput to throw');
}

describe('parseModelOutput', () => {
  const json = JSON.stringify(validResultJson);

  it('parses clean JSON', () => {
    expect(parseModelOutput(json)).toEqual(validResultJson);
  });

  it('parses JSON inside ```json fences', () => {
    expect(parseModelOutput(`Here is my review:\n\`\`\`json\n${json}\n\`\`\`\n`)).toEqual(
      validResultJson,
    );
  });

  it('parses JSON followed by trailing text', () => {
    expect(parseModelOutput(`${json}\n\nLet me know if you need more detail.`)).toEqual(
      validResultJson,
    );
  });

  it('parses JSON with leading prose and braces inside strings', () => {
    const tricky = { ...validResultJson, summary: 'Uses {braces} and "quotes" }' };
    expect(parseModelOutput(`Sure! ${JSON.stringify(tricky)} done`)).toEqual(tricky);
  });

  it('strips unknown keys (e.g. a full ReviewResult)', () => {
    const full = {
      schema_version: 1,
      repo: 'a/b',
      pr_number: 1,
      head_sha: 'x',
      ...validResultJson,
    };
    expect(parseModelOutput(JSON.stringify(full))).toEqual(validResultJson);
  });

  it('rejects empty output', () => expectInvalid('   '));
  it('rejects text with no JSON', () => expectInvalid('Looks good to me!'));
  it('rejects truncated JSON', () => expectInvalid(json.slice(0, -10)));
  it('rejects schema-invalid JSON', () => {
    expectInvalid(JSON.stringify({ ...validResultJson, risk_score: 150 }));
    expectInvalid(
      JSON.stringify({
        ...validResultJson,
        issues: [{ ...validResultJson.issues[0], severity: 'urgent' }],
      }),
    );
    expectInvalid(
      JSON.stringify({ ...validResultJson, issues: [{ ...validResultJson.issues[0], line: 0 }] }),
    );
  });
});

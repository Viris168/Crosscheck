import { ProviderError } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { getProvider, mockReview } from './index';
import { sampleInput } from './test-fixtures';

describe('getProvider', () => {
  it.each([
    ['platform', true],
    ['codex_chatgpt', true],
    ['claude_action', false],
    ['codex_action', false],
  ] as const)('%s runsInWorker=%s', (id, runsInWorker) => {
    const p = getProvider(id);
    expect(p.id).toBe(id);
    expect(p.runsInWorker).toBe(runsInWorker);
    expect(getProvider(id)).toBe(p); // cached
  });

  it.each(['claude_action', 'codex_action'] as const)('%s.reviewChunk throws', async (id) => {
    await expect(getProvider(id).reviewChunk(sampleInput(), { orgId: 'o' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('mock provider is deterministic', async () => {
    const p = getProvider('mock');
    const a = await p.reviewChunk(sampleInput(), { orgId: 'o' });
    const b = await p.reviewChunk(sampleInput(), { orgId: 'o' });
    expect(a).toEqual(b);
    expect(a).toEqual(mockReview(sampleInput()));
    expect(a.issues[0]).toMatchObject({ file: 'src/users.ts', line: 1 });
  });
});

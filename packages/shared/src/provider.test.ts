import { describe, expect, it } from 'vitest';
import { ProviderError } from './provider';

describe('ProviderError', () => {
  it('carries an ErrorCode and message', () => {
    const e = new ProviderError('rate_limited', '429 from provider');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('rate_limited');
    expect(e.message).toBe('429 from provider');
    expect(e.name).toBe('ProviderError');
  });
});

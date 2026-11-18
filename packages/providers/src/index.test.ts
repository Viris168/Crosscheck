import { describe, expect, it } from 'vitest';
import * as mod from './index';

describe('package skeleton', () => {
  it('loads its public entry', () => {
    expect(mod).toBeTypeOf('object');
  });
});

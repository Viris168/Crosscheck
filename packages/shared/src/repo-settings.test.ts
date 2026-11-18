import { describe, expect, it } from 'vitest';
import { defaultRepoSettings, RepoSettingsSchema } from './repo-settings';

describe('RepoSettingsSchema', () => {
  it('fills every default from an empty object', () => {
    expect(defaultRepoSettings()).toEqual({
      minSeverity: 'medium',
      ignorePaths: ['dist/**', '**/*.lock', 'pnpm-lock.yaml', 'package-lock.json'],
      maxIssuesPerPr: 30,
      language: 'en',
      trigger: 'every_push',
    });
  });

  it('keeps provided values', () => {
    const s = RepoSettingsSchema.parse({ minSeverity: 'high', trigger: 'on_command', model: 'x' });
    expect(s.minSeverity).toBe('high');
    expect(s.trigger).toBe('on_command');
    expect(s.model).toBe('x');
  });

  it('rejects bad values', () => {
    expect(RepoSettingsSchema.safeParse({ minSeverity: 'info' }).success).toBe(false);
    expect(RepoSettingsSchema.safeParse({ maxIssuesPerPr: 2.5 }).success).toBe(false);
    expect(RepoSettingsSchema.safeParse({ trigger: 'nightly' }).success).toBe(false);
  });
});

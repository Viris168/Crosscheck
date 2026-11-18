import { describe, expect, it } from 'vitest';
import { annotatePatch, buildActionPrompt, buildReviewPrompt } from './prompt';
import { samplePatch, sampleInput } from './test-fixtures';

describe('annotatePatch', () => {
  it('numbers new-side lines and leaves removed lines unnumbered', () => {
    const out = annotatePatch(samplePatch).split('\n');
    expect(out).toContain('    1 |  import { db } from \'./db\';');
    expect(out).toContain("      | -export function getUser(id) {");
    expect(out).toContain('    2 | +export async function getUser(id: string) {');
    expect(out).toContain('    5 | +  return rows[0];');
    expect(out).toContain('   23 | +  // unreachable');
    expect(out.at(-1)).toBe('   24 |  }');
  });
});

describe('buildReviewPrompt', () => {
  it('matches snapshot', () => {
    const { system, user } = buildReviewPrompt(sampleInput());
    expect(system).toMatchSnapshot('system');
    expect(user).toMatchSnapshot('user');
  });

  it('states chunk position, intent, and file headers', () => {
    const { system, user } = buildReviewPrompt(sampleInput({ chunkIndex: 2, chunkCount: 5 }));
    expect(system).toContain('chunk 3 of 5');
    expect(system).toContain('"risk_score"');
    expect(user).toContain('### src/users.ts (modified)');
    expect(user).toContain('Security fix only');
    expect(user).toContain('All DB access must use parameters.');
  });

  it('marks missing optional context as (none)', () => {
    const { user } = buildReviewPrompt(sampleInput({ intentNotes: undefined, guidelines: '' }));
    expect(user).toContain('## Intent notes\n(none)');
    expect(user).toContain('## Repository guidelines\n(none)');
  });

  it('uses a fence longer than any backtick run in the patch', () => {
    const patch = '@@ -0,0 +1,1 @@\n+const md = "````";\n';
    const { user } = buildReviewPrompt(
      sampleInput({ files: [{ path: 'a.md', status: 'added', patch }] }),
    );
    expect(user).toContain('`````diff\n');
  });
});

describe('buildActionPrompt', () => {
  it('matches snapshot', () => {
    expect(buildActionPrompt({ schemaVersion: 1 })).toMatchSnapshot();
  });

  it('asks for review.json only and contains placeholders', () => {
    const p = buildActionPrompt({ schemaVersion: 1 });
    expect(p).toContain('review.json');
    expect(p).toContain('{{REPO}}');
    expect(p).toContain('{{HEAD_SHA}}');
    expect(p).toContain('Do NOT post comments');
  });
});

import type { ReviewIssue, RiskResult } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { escapeMarkdown } from './escape';
import {
  SUMMARY_MARKER,
  formatIssueComment,
  formatOverflowList,
  formatSummary,
  isSuggestable,
} from './format';

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  file: 'src/a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  title: 'Off by one',
  explanation: 'Loop runs one time too many.',
  ...over,
});

describe('escapeMarkdown', () => {
  it('neutralises HTML', () => {
    const out = escapeMarkdown('<img src=x onerror=alert(1)> & <script>');
    expect(out).not.toMatch(/<|>/);
    expect(out).toContain('&lt;img');
    expect(out).toContain('&amp;');
  });

  it('escapes markdown syntax (links, images, emphasis, headings, tables)', () => {
    const out = escapeMarkdown('# Title [click](https://evil) ![x](y) **bold** | a |');
    expect(out).toBe(
      '\\# Title \\[click\\]\\(https\\://evil\\) \\!\\[x\\]\\(y\\) \\*\\*bold\\*\\* \\| a \\|',
    );
  });

  it('wraps user and team mentions in backticks', () => {
    expect(escapeMarkdown('cc @octocat and @my-org/security-team.')).toBe(
      'cc `@octocat` and `@my-org/security-team.`',
    );
  });

  it('does not treat emails as mentions', () => {
    expect(escapeMarkdown('mail a@b.com')).toBe('mail a@b\\.com');
  });

  it('neutralises backticks so a mention cannot escape its code span', () => {
    expect(escapeMarkdown('`@octocat`')).toBe('\\``@octocat`\\`');
  });

  it('mentions at the start of text', () => {
    expect(escapeMarkdown('@admin fix this')).toBe('`@admin` fix this');
  });
});

describe('formatIssueComment', () => {
  it('has a severity badge, category and escaped title + explanation', () => {
    const body = formatIssueComment(
      issue({ title: 'Use `===` <b>', explanation: 'Ping @alice\n\nsee [docs](http://x)' }),
    );
    expect(body.split('\n')[0]).toBe('**🟠 High · bug** — Use \\`\\=\\=\\=\\` &lt;b&gt;');
    expect(body).toContain('Ping `@alice`');
    expect(body).toContain('see \\[docs\\]\\(http\\://x\\)');
    expect(body).not.toContain('suggestion');
  });

  it.each([
    ['critical', '🔴 Critical'],
    ['medium', '🟡 Medium'],
    ['low', '🔵 Low'],
  ] as const)('%s badge', (severity, badge) => {
    expect(formatIssueComment(issue({ severity }))).toContain(badge);
  });

  it('uses a suggestion block for a single-line fix', () => {
    const body = formatIssueComment(issue({ suggested_fix: '  for (let i = 0; i < n; i++) {\n' }));
    expect(body).toContain('```suggestion\n  for (let i = 0; i < n; i++) {\n```');
  });

  it('uses a plain code block for a multi-line fix', () => {
    const body = formatIssueComment(issue({ suggested_fix: 'a();\nb();' }));
    expect(body).toContain('**Suggested fix**\n\n```\na();\nb();\n```');
    expect(body).not.toContain('suggestion');
  });

  it('a fix with backticks cannot close the fence early', () => {
    const body = formatIssueComment(issue({ suggested_fix: 'const s = ```x```;' }));
    expect(body).toContain('````suggestion\nconst s = ```x```;\n````');
  });

  it('leaves code inside fences untouched (no escaping of the fix)', () => {
    const body = formatIssueComment(issue({ suggested_fix: 'if (a < b && c) {}' }));
    expect(body).toContain('if (a < b && c) {}');
  });

  it('ignores an empty fix', () => {
    expect(formatIssueComment(issue({ suggested_fix: '  \n' }))).not.toContain('```');
    expect(isSuggestable('')).toBe(false);
    expect(isSuggestable(undefined)).toBe(false);
  });
});

describe('formatSummary', () => {
  const risk: RiskResult = {
    score: 62,
    level: 'high',
    factors: [
      { key: 'ai_score', label: 'AI risk score 80/100', points: 32 },
      { key: 'sensitive_paths', label: 'Touches sensitive paths: src/auth|x.ts', points: 10 },
    ],
  };
  const args = {
    risk,
    summary: 'Looks fine, but @bob should check <auth>.',
    issueCount: 60,
    postedCount: 50,
    provider: 'claude_action' as const,
    dashboardUrl: 'https://review.example.com/reviews/r1',
  };

  it('renders marker, header, escaped summary, factors, counts, provider, link', () => {
    const body = formatSummary(args);
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain('## 🟠 AI review — risk 62/100 (high)');
    expect(body).toContain('`@bob` should check &lt;auth&gt;');
    expect(body).toContain('| AI risk score 80/100 | +32 |');
    expect(body).toContain('src/auth\\|x\\.ts');
    expect(body).toContain(
      '**60 findings**, 50 posted inline (10 listed below or in the dashboard).',
    );
    expect(body).toContain('Claude (your GitHub Action)');
    expect(body).toContain('[Open in dashboard](https://review.example.com/reviews/r1)');
  });

  it('drops non-http dashboard URLs', () => {
    const body = formatSummary({ ...args, dashboardUrl: 'javascript:alert(1)' });
    expect(body).not.toContain('Open in dashboard');
  });

  it('says so when there are no findings', () => {
    const body = formatSummary({
      ...args,
      issueCount: 0,
      postedCount: 0,
      risk: { ...risk, factors: [] },
    });
    expect(body).toContain('No findings.');
    expect(body).not.toContain('| Risk factor');
  });
});

describe('formatOverflowList', () => {
  it('lists escaped findings', () => {
    const out = formatOverflowList([issue({ file: 'src/*x*.ts', title: 'hi @carol' })]);
    expect(out).toContain('### Not posted inline (1)');
    expect(out).toContain('- **🟠 High** src/\\*x\\*\\.ts\\:3 — hi `@carol`');
  });

  it('is empty for no issues', () => {
    expect(formatOverflowList([])).toBe('');
  });
});

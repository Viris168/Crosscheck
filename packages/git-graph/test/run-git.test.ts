import { describe, expect, it } from 'vitest';
import { buildGitEnv, GitError, runGit, scrub } from '../src/git';

describe('scrub', () => {
  it('removes tokens, auth headers and URL credentials', () => {
    const token = 'ghs_abcdefghijklmnop1234';
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    const text = [
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`,
      `fatal: AUTHORIZATION: basic ${b64}`,
      `https://x-access-token:${token}@github.com/o/r.git`,
      `token ${token}`,
    ].join('\n');
    const out = scrub(text);
    expect(out).not.toContain(token);
    expect(out).not.toContain(b64);
    expect(scrub('value plainsecretvalue here', ['plainsecretvalue'])).toBe('value *** here');
  });
});

describe('runGit', () => {
  it('always disables prompts and lazy fetch, and drops inherited repo pointers', () => {
    const env = buildGitEnv({ GIT_TERMINAL_PROMPT: '1', FOO: 'bar' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_NO_LAZY_FETCH).toBe('1');
    expect(env.FOO).toBe('bar');
    process.env.GIT_DIR = '/elsewhere';
    try {
      expect(buildGitEnv().GIT_DIR).toBeUndefined();
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it('runs without a shell', async () => {
    const r = await runGit(['--version']);
    expect(r.stdout).toMatch(/^git version/);
    // shell metacharacters are passed through literally, not interpreted
    await expect(runGit(['--git-dir', '/nonexistent; echo pwned', 'log'])).rejects.toBeInstanceOf(
      GitError,
    );
  });

  it('scrubs secrets passed through config env from errors', async () => {
    const token = 'ghs_SECRETSECRETSECRET123';
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const err = await runGit(['ls-remote', `file:///nonexistent/${token}`], {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: header,
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).not.toContain(token);
    expect((err as GitError).message).toMatch(/git ls-remote failed/);
  });

  it('kills git on timeout', async () => {
    // hash-object --stdin waits on a stdin that is never closed
    const err = await runGit(['hash-object', '--stdin'], { timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).timedOut).toBe(true);
  });

  it('treats okExitCodes as success', async () => {
    const r = await runGit(['merge-base', '--is-ancestor', 'nope', 'nope'], { okExitCodes: [128] });
    expect(r.exitCode).toBe(128);
  });
});

// A commits-only cache clone of a fixture, made the way T2c's `ensureClone` makes it
// (`clone --bare --filter=tree:0`, then promisor=false and no partialclonefilter). Tests only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FixtureRepo } from './fixture-repo';

/** Keeps a developer's global/system git config out of the clone. */
export const ISOLATED_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function commitsOnlyClone(repo: FixtureRepo): { gitDir: string; remove: () => void } {
  // file:// goes through upload-pack, which ignores --filter unless the "server" allows it.
  repo.run('config', 'uploadpack.allowFilter', 'true');
  repo.run('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const root = mkdtempSync(join(tmpdir(), 'git-graph-cache-'));
  const gitDir = join(root, 'cache.git');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      env: { ...process.env, ...ISOLATED_GIT_ENV, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('clone', '--bare', '--filter=tree:0', '--no-tags', '--quiet', '--', repo.url, gitDir);
  git('--git-dir', gitDir, 'config', 'remote.origin.promisor', 'false');
  git('--git-dir', gitDir, 'config', '--unset-all', 'remote.origin.partialclonefilter');
  git('--git-dir', gitDir, 'config', 'gc.auto', '0');
  return { gitDir, remove: () => rmSync(root, { recursive: true, force: true }) };
}

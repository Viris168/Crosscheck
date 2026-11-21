// DEV ONLY. Seeds a 500-branch / 50k-commit generated repo ("demo/scale-500") for the T6b scale check:
// a bare clone in REPO_CACHE_DIR built with `git fast-import` (synthetic commits, one empty tree), the
// `RepoGraph` snapshot built from it by the real engine, `Branch` rows and `PullRequest` rows (every
// 7th PR authored by the first user with a GitHub login, for the "mine" filter).
// It attaches to the org/installation of the first repo in the DB (run `pnpm db:seed` first).
// Never run against production: it writes a fake repo and a fake clone.
//
//   pnpm exec tsx --env-file=.env apps/web/scripts/seed-scale-tree.ts            # seed / reseed
//   pnpm exec tsx --env-file=.env apps/web/scripts/seed-scale-tree.ts --remove   # delete it again
/* eslint-disable no-console -- prints measurements on purpose */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@app/db';
import { buildSnapshot } from '@app/git-graph';
import { readCommitGraph } from '@app/git-graph/git';
import { TreeSnapshotSchema } from '@app/shared';
import { scaleRepo } from '../src/components/tree/__fixtures__/scale-repo';

const GITHUB_REPO_ID = 990_000_500;
const FULL_NAME = 'demo/scale-500';

if (process.env.NODE_ENV === 'production') throw new Error('seed-scale-tree is dev only');
// Relative to apps/web: the Next app (and its Inngest functions) run there, so that is where a
// relative REPO_CACHE_DIR points for GET /tree/compare.
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.resolve(webDir, process.env.REPO_CACHE_DIR ?? './.cache/repos');
const gitDir = path.join(cacheDir, `${GITHUB_REPO_ID}.git`);

async function remove() {
  await prisma.repo.deleteMany({ where: { githubRepoId: GITHUB_REPO_ID } }); // cascades
  rmSync(gitDir, { recursive: true, force: true });
  console.log(`removed ${FULL_NAME} and ${gitDir}`);
}

/** Bare repo with the generated history; refs only for branch heads. Returns name → real head SHA. */
function buildClone(repo: ReturnType<typeof scaleRepo>): Map<string, string> {
  rmSync(gitDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', gitDir]);
  const mark = new Map(repo.commits.map((c, i) => [c.sha, i + 1]));
  const lines: string[] = [];
  repo.commits.forEach((c, i) => {
    const when = Math.floor(Date.parse(c.committedAt) / 1000);
    const msg = `c${i}`; // unique, so git keeps every synthetic commit
    lines.push('commit refs/heads/__seed', `mark :${i + 1}`);
    lines.push(`committer seed <seed@example.invalid> ${when} +0000`, `data ${msg.length}`, msg);
    lines.push(c.parents[0] ? `from :${mark.get(c.parents[0])}` : 'deleteall');
    lines.push('');
  });
  for (const b of repo.branches)
    lines.push(`reset refs/heads/${b.name}`, `from :${mark.get(b.headSha)}`, '');
  lines.push('reset refs/heads/__seed', 'from 0000000000000000000000000000000000000000', '');
  execFileSync('git', ['--git-dir', gitDir, 'fast-import', '--quiet', '--force'], {
    input: `${lines.join('\n')}\n`,
    maxBuffer: 1 << 28,
  });
  execFileSync('git', ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const out = execFileSync('git', [
    '--git-dir',
    gitDir,
    'for-each-ref',
    '--format=%(objectname) %(refname:lstrip=2)',
    'refs/heads/',
  ]).toString();
  return new Map(
    out
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
      .map(([sha, name]) => [name!, sha!]),
  );
}

async function seed() {
  const anchor = await prisma.repo.findFirst({
    where: { githubRepoId: { not: GITHUB_REPO_ID } },
    select: { orgId: true, installationId: true },
  });
  if (!anchor) throw new Error('No repo to attach to: run `pnpm db:seed` first.');
  const me = await prisma.user.findFirst({
    where: { login: { not: null } },
    select: { login: true },
  });

  let t = performance.now();
  const gen = scaleRepo();
  const heads = buildClone(gen);
  console.log(
    `clone: ${gen.commits.length} commits, ${heads.size} branches (${(performance.now() - t).toFixed(0)} ms)`,
  );

  t = performance.now();
  const { commits, truncated } = await readCommitGraph(gitDir, [...heads.values()]);
  const branches = gen.branches.map((b) => ({ name: b.name, headSha: heads.get(b.name)! }));
  const headOf = new Map(branches.map((b) => [b.name, b.headSha]));
  const prs = gen.prs.map((p) => ({ ...p, headSha: headOf.get(p.headRef)! }));
  const ci = Object.fromEntries(
    gen.branches.flatMap((b) =>
      gen.ci[b.headSha] ? [[headOf.get(b.name)!, gen.ci[b.headSha]!]] : [],
    ),
  );
  const snapshot = TreeSnapshotSchema.parse(
    buildSnapshot({
      defaultBranch: gen.defaultBranch,
      branches,
      graph: commits,
      prs,
      ci,
      truncated,
      maxCommitsPerBranch: 30,
    }),
  );
  console.log(
    `snapshot: ${snapshot.commits.length} drawn commits (${(performance.now() - t).toFixed(0)} ms)`,
  );

  const repo = await prisma.repo.upsert({
    where: { githubRepoId: GITHUB_REPO_ID },
    create: { githubRepoId: GITHUB_REPO_ID, fullName: FULL_NAME, ...anchor },
    update: { fullName: FULL_NAME, active: true },
    select: { id: true },
  });
  await prisma.$transaction([
    prisma.branch.deleteMany({ where: { repoId: repo.id } }),
    prisma.pullRequest.deleteMany({ where: { repoId: repo.id } }),
    prisma.branch.createMany({
      data: branches.map((b) => ({
        repoId: repo.id,
        name: b.name,
        headSha: b.headSha,
        isDefault: b.name === gen.defaultBranch,
      })),
    }),
    prisma.pullRequest.createMany({
      data: prs.map((p) => ({
        repoId: repo.id,
        number: p.number,
        title: `Synthetic PR ${p.number}`,
        author: me?.login && gen.minePrs.includes(p.number) ? me.login : 'someone-else',
        state: p.state,
        headSha: p.headSha,
        baseRef: p.baseRef,
        headRef: p.headRef,
        mergedAt: p.state === 'merged' ? new Date() : null,
      })),
    }),
    prisma.repoGraph.upsert({
      where: { repoId: repo.id },
      create: {
        repoId: repo.id,
        status: 'ready',
        defaultBranch: gen.defaultBranch,
        syncedAt: new Date(),
        snapshot,
      },
      update: { status: 'ready', errorCode: null, syncedAt: new Date(), snapshot },
    }),
  ]);

  // The DB read GET /tree does on every 200.
  t = performance.now();
  await prisma.repoGraph.findUnique({ where: { repoId: repo.id } });
  console.log(
    `RepoGraph read (2+ MB JSON from Postgres): ${(performance.now() - t).toFixed(0)} ms`,
  );
  console.log(`seeded ${FULL_NAME}: /repos/${repo.id}/tree`);
}

(process.argv.includes('--remove') ? remove() : seed())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

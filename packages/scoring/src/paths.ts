import { SENSITIVE_PATH_PATTERNS } from './weights';

const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|testing)\//i,
  /\.(test|spec|e2e)\.[^/]+$/i,
  /_test\.[^/]+$/i, // go, python
  /(^|\/)test_[^/]+\.py$/i,
  /Tests?\.(java|kt|cs|swift|scala)$/,
];

const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'py',
  'go',
  'rb',
  'java',
  'kt',
  'kts',
  'scala',
  'rs',
  'cs',
  'php',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'm',
  'mm',
  'ex',
  'exs',
  'erl',
  'clj',
  'dart',
  'lua',
  'sql',
]);

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

/** Code that should come with tests (not docs, config, assets, or tests themselves). */
export function isSourcePath(path: string): boolean {
  if (isTestPath(path)) return false;
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

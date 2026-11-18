export const queryKeys = {
  repos: ['repos'] as const,
  repoSettings: (repoId: string) => ['repos', repoId, 'settings'] as const,
  pulls: (repoId: string, state: string) => ['repos', repoId, 'pulls', state] as const,
  pull: (repoId: string, number: number) => ['repos', repoId, 'pull', number] as const,
  review: (id: string) => ['reviews', id] as const,
  overview: (orgId: string, range: string) => ['orgs', orgId, 'overview', range] as const,
  chatgptConnection: ['connections', 'chatgpt'] as const,
};

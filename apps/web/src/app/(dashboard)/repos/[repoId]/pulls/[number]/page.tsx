import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { PullDetail } from '@/components/pulls/pull-detail';
import { loadRepoForPage } from '../../repo-header';

export default async function PullPage({
  params,
}: {
  params: Promise<{ repoId: string; number: string }>;
}) {
  const { repoId, number } = await params;
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) notFound();
  const repo = await loadRepoForPage(repoId);
  return (
    <Suspense>
      <PullDetail repoId={repo.id} number={n} />
    </Suspense>
  );
}

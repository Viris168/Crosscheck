import { Suspense } from 'react';
import { ChatGptConnectionCard } from '@/components/connections/chatgpt-connection';

export const metadata = { title: 'Connections · AI Code Review' };

export default function ConnectionsPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Claude tokens and OpenAI keys for GitHub Actions live in your repository secrets — never
          here.
        </p>
      </div>
      <Suspense>
        <ChatGptConnectionCard />
      </Suspense>
    </div>
  );
}

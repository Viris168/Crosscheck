'use client';

import { CheckCircle2, PlugZap } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { QueryError } from '@/components/query-error';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  chatgptConnectUrl,
  useChatGptConnection,
  useDisconnectChatGpt,
} from '@/hooks/use-connections';

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'ChatGPT sign-in was cancelled.',
  invalid_state: 'The sign-in link expired or was already used. Try again.',
  not_implemented: 'Sign in with ChatGPT is not available yet.',
  no_org: 'Join or create an organization first.',
  forbidden: 'You are not a member of this organization.',
};

export function ChatGptConnectionCard({
  returnTo = '/settings/connections',
}: {
  returnTo?: string;
}) {
  const params = useSearchParams();
  const { data, error, isPending } = useChatGptConnection();
  const disconnect = useDisconnectChatGpt();
  const oauthError = params.get('error');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap aria-hidden className="size-4" /> ChatGPT
        </CardTitle>
        <CardDescription>
          Use your ChatGPT plan to run Codex reviews. Tokens are stored encrypted and only used for
          reviews in this organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {oauthError && (
          <Alert tone="error">
            {OAUTH_ERRORS[oauthError] ?? 'Could not connect ChatGPT. Try again.'}
          </Alert>
        )}
        {params.get('connected') === 'chatgpt' && <Alert tone="success">ChatGPT connected.</Alert>}
        {isPending ? (
          <Skeleton className="h-5 w-40" />
        ) : error ? (
          <QueryError error={error} what="connection" />
        ) : data.connected ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 aria-hidden className="size-4 text-green-700" /> Connected
            {data.connectedAt && (
              <span className="text-muted-foreground">
                since {new Date(data.connectedAt).toLocaleDateString()}
              </span>
            )}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Not connected.</p>
        )}
      </CardContent>
      <CardFooter>
        {data?.connected ? (
          <>
            <a
              className={buttonVariants({ variant: 'outline' })}
              href={chatgptConnectUrl(returnTo)}
            >
              Reconnect
            </a>
            <Button
              variant="destructive"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <a className={buttonVariants()} href={chatgptConnectUrl(returnTo)}>
            Sign in with ChatGPT
          </a>
        )}
        {disconnect.error && <Alert tone="error">{disconnect.error.message}</Alert>}
      </CardFooter>
    </Card>
  );
}

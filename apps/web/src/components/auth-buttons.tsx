'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { signIn, signOut } from '@/lib/auth-client';

export function SignInButton() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await signIn.social({ provider: 'github', callbackURL: '/' });
        setPending(false);
      }}
    >
      Sign in with GitHub
    </Button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      onClick={async () => {
        await signOut();
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}

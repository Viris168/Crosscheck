'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Label, Select } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export function OrgSwitcher({
  orgs,
  currentOrgId,
}: {
  orgs: { id: string; name: string }[];
  currentOrgId: string | null;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  if (orgs.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="org-switcher" className="sr-only">
        Organization
      </Label>
      <Select
        id="org-switcher"
        className="h-8 w-auto"
        value={currentOrgId ?? ''}
        disabled={pending}
        onChange={async (e) => {
          setPending(true);
          // VERIFY: better-auth organization client `organization.setActive({ organizationId })`.
          await authClient.organization.setActive({ organizationId: e.target.value });
          qc.clear();
          setPending(false);
          router.push('/');
          router.refresh();
        }}
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

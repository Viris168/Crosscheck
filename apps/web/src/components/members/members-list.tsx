'use client';

import { MemberRole, type OrgMember } from '@app/shared/client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { QueryError } from '@/components/query-error';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/skeleton';
import { useMembers, useUpdateMemberRole } from '@/hooks/use-members';

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const ROLE_TONE: Record<MemberRole, BadgeTone> = {
  owner: 'purple',
  admin: 'blue',
  member: 'neutral',
};

export interface MembersListProps {
  orgId: string;
  /** The viewer is an org owner: role selects + the permission banner. */
  isOwner: boolean;
  currentUserId: string;
  /** GitHub page where the client accepts the App's new permissions. */
  permissionUrl: string | null;
}

export function MembersList({ orgId, isOwner, currentUserId, permissionUrl }: MembersListProps) {
  const { data, error, isPending } = useMembers(orgId);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Members come from GitHub. Add or remove people in your GitHub organization.
      </p>
      {isOwner && data?.needsMemberPermission && (
        <Alert tone="warning">
          <span>
            Accept the new GitHub App permissions to sync members.{' '}
            {permissionUrl && (
              <a
                className="font-medium underline"
                href={permissionUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Review permissions on GitHub
              </a>
            )}
          </span>
        </Alert>
      )}
      {isPending ? (
        <LoadingState label="Loading members…" />
      ) : error ? (
        <QueryError error={error} what="organization" />
      ) : (
        <MemberTable
          orgId={orgId}
          members={data.members}
          isOwner={isOwner}
          currentUserId={currentUserId}
        />
      )}
    </div>
  );
}

function MemberTable({
  orgId,
  members,
  isOwner,
  currentUserId,
}: {
  orgId: string;
  members: OrgMember[];
  isOwner: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const update = useUpdateMemberRole(orgId);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function changeRole(m: OrgMember, role: MemberRole) {
    if (role === m.role) return;
    setPendingId(m.id);
    update.mutate(
      { memberId: m.id, role },
      {
        onSuccess: () => {
          // The viewer's own role drives server-rendered parts (owner controls); re-render them.
          if (m.userId === currentUserId) router.refresh();
        },
        onSettled: () => setPendingId(null),
      },
    );
  }

  return (
    <Card>
      {update.error && (
        <div className="px-5 pt-4">
          <Alert tone="error">{update.error.message || 'Could not change the role. Try again.'}</Alert>
        </div>
      )}
      <CardContent className="p-0">
        <ul aria-label="Members" className="divide-y">
          {members.map((m) => {
            const label = m.login ?? m.name;
            return (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                {m.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar, small and external
                  <img
                    src={m.avatarUrl}
                    alt=""
                    width={32}
                    height={32}
                    className="size-8 shrink-0 rounded-full bg-secondary"
                  />
                ) : (
                  <span aria-hidden className="size-8 shrink-0 rounded-full bg-secondary" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {m.login ? (
                      <a
                        className="hover:underline"
                        href={`https://github.com/${encodeURIComponent(m.login)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {m.login}
                      </a>
                    ) : (
                      m.name
                    )}
                    {m.userId === currentUserId && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </div>
                  {m.login && m.name && m.name !== m.login && (
                    <div className="truncate text-xs text-muted-foreground">{m.name}</div>
                  )}
                </div>
                {isOwner ? (
                  <Select
                    aria-label={`Role for ${label}`}
                    className="w-32"
                    value={m.role}
                    disabled={pendingId !== null}
                    onChange={(e) => changeRole(m, e.target.value as MemberRole)}
                  >
                    {MemberRole.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

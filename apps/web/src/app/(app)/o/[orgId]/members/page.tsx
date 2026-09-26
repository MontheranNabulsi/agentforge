'use client';

import type { MemberDto, Role } from '@agentforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { ErrorBox, PageHeader, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { initials, timeAgo } from '@/lib/format';
import { canManage, useCurrentOrg, useMe } from '@/lib/hooks';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including managing owners',
  admin: 'Manage members, projects, agents and see the audit log',
  member: 'Chat, upload documents, run evaluations, decide approvals',
  viewer: 'Read-only access',
};

export default function MembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { role } = useCurrentOrg();
  const me = useMe();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ email: string; role: Exclude<Role, 'owner'> }>({
    email: '',
    role: 'member',
  });
  const members = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api<MemberDto[]>(`/orgs/${orgId}/members`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members', orgId] });

  const add = useMutation({
    mutationFn: () => api<MemberDto>(`/orgs/${orgId}/members`, { body: form }),
    onSuccess: async (member) => {
      toast.success(`${member.name} joined as ${member.role}`);
      setAdding(false);
      setForm({ email: '', role: 'member' });
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      api<MemberDto>(`/orgs/${orgId}/members/${input.userId}`, {
        method: 'PATCH',
        body: { role: input.role },
      }),
    onSuccess: async () => {
      toast.success('Role updated');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Member removed');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const manage = canManage(role);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Members"
        description="Roles apply to every project in the organization."
        actions={
          manage ? (
            <Button onClick={() => setAdding(true)}>
              <UserPlus /> Add member
            </Button>
          ) : null
        }
      />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          title="Add a member"
          description="They need an AgentForge account first; ask them to sign up, then add them by email."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Field label="Email" htmlFor="member-email">
              <Input
                id="member-email"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Role" htmlFor="member-role" hint={ROLE_HELP[form.role]}>
              <Select
                id="member-role"
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value as Exclude<Role, 'owner'> })
                }
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={add.isPending}>
                Add member
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {members.isError ? <ErrorBox error={members.error} /> : null}
      <Card className="divide-y divide-border">
        {!members.data
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="m-4 h-10" />)
          : members.data.map((member) => {
              const self = member.userId === me.data?.user.id;
              return (
                <div key={member.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                    {initials(member.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {member.name} {self ? <Badge tone="outline">you</Badge> : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {member.email} · joined {timeAgo(member.joinedAt)}
                    </p>
                  </div>
                  {manage && !self ? (
                    <div className="flex items-center gap-2">
                      <Select
                        aria-label={`Role of ${member.name}`}
                        className="h-8 w-28"
                        value={member.role}
                        onChange={(e) =>
                          changeRole.mutate({ userId: member.userId, role: e.target.value as Role })
                        }
                      >
                        {role === 'owner' || member.role === 'owner' ? (
                          <option value="owner">Owner</option>
                        ) : null}
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove.mutate(member.userId)}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <Badge
                      tone={member.role === 'owner' ? 'primary' : 'neutral'}
                      className="capitalize"
                    >
                      {member.role}
                    </Badge>
                  )}
                </div>
              );
            })}
      </Card>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
          <div key={r} className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium capitalize">{r}</p>
            <p className="mt-0.5 text-muted-foreground">{ROLE_HELP[r]}</p>
          </div>
        ))}
      </div>
    </>
  );
}

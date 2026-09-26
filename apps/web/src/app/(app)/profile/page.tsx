'use client';

import { PASSWORD_MIN_LENGTH, type UserDto } from '@agentforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from '@/lib/hooks';

export default function ProfilePage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  useEffect(() => {
    if (me.data) setName(me.data.user.name);
  }, [me.data]);

  const saveProfile = useMutation({
    mutationFn: () => api<UserDto>('/auth/me', { method: 'PATCH', body: { name } }),
    onSuccess: async () => {
      toast.success('Profile saved');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const changePassword = useMutation({
    mutationFn: () => api('/auth/me/password', { body: passwords }),
    onSuccess: () => {
      toast.success('Password changed; other sessions were signed out');
      setPasswords({ currentPassword: '', newPassword: '' });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <PageHeader
        title="Profile & security"
        description={
          me.data
            ? `${me.data.user.email} · member since ${dateTime(me.data.user.createdAt)}`
            : undefined
        }
      />
      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                saveProfile.mutate();
              }}
            >
              <Field label="Display name" htmlFor="profile-name" className="flex-1">
                <Input
                  id="profile-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button type="submit" loading={saveProfile.isPending}>
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>
              Changing it signs out every other session. Passwords are hashed with Argon2id.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                changePassword.mutate();
              }}
            >
              <Field label="Current password" htmlFor="current-password">
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={passwords.currentPassword}
                  onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
                />
              </Field>
              <Field
                label="New password"
                htmlFor="new-password"
                hint={`At least ${PASSWORD_MIN_LENGTH} characters`}
              >
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  value={passwords.newPassword}
                  onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" loading={changePassword.isPending}>
                  Change password
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Signed in with an HTTP-only session cookie that expires{' '}
            {me.data ? dateTime(me.data.session.expiresAt) : '—'} (it slides forward while you are
            active).
          </CardContent>
        </Card>
      </div>
    </>
  );
}

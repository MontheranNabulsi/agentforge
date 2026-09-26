'use client';

import { PASSWORD_MIN_LENGTH, type MeResponse } from '@agentforge/contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ErrorBox } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const fieldError = (path: string) =>
    error instanceof ApiError ? error.fieldErrors.find((f) => f.path === path)?.message : undefined;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        You get a personal organization; create projects and invite teammates from there.
      </p>
      <Card>
        <CardContent className="pt-5">
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setPending(true);
              setError(null);
              try {
                const me = await api<MeResponse>('/auth/register', { body: form });
                queryClient.setQueryData(['me'], me);
                router.push('/app');
              } catch (err) {
                setError(err);
                setPending(false);
              }
            }}
          >
            <Field label="Name" htmlFor="name" error={fieldError('name')}>
              <Input
                id="name"
                autoComplete="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Email" htmlFor="email" error={fieldError('email')}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field
              label="Password"
              htmlFor="password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              error={fieldError('password')}
            >
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
            {error && !(error instanceof ApiError && error.fieldErrors.length > 0) ? (
              <ErrorBox error={error} />
            ) : null}
            <Button type="submit" className="w-full" loading={pending}>
              Create account
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-primary">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </>
  );
}

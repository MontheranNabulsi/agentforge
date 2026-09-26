'use client';

import { PASSWORD_MIN_LENGTH } from '@agentforge/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ErrorBox } from '@/components/ui/misc';
import { api } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  if (done) {
    return (
      <p className="text-sm">
        Your password was changed and your other sessions were signed out.{' '}
        <Link href="/login" className="font-medium text-primary">
          Sign in
        </Link>
      </p>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          await api('/auth/password-reset/confirm', { body: { token, newPassword: password } });
          setDone(true);
        } catch (err) {
          setError(err);
        } finally {
          setPending(false);
        }
      }}
    >
      {!token ? (
        <ErrorBox error={new Error('This link has no reset token. Request a new link.')} />
      ) : null}
      <Field
        label="New password"
        htmlFor="password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      >
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error ? <ErrorBox error={error} /> : null}
      <Button type="submit" className="w-full" loading={pending} disabled={!token}>
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <Card>
        <CardContent className="pt-5">
          <Suspense>
            <ResetForm />
          </Suspense>
        </CardContent>
      </Card>
    </>
  );
}

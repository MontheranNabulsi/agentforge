'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ErrorBox } from '@/components/ui/misc';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        We’ll email you a link that is valid for 30 minutes.
      </p>
      <Card>
        <CardContent className="pt-5">
          {sent ? (
            <p className="text-sm">
              If an account exists for <strong>{email}</strong>, a reset link is on its way. On this
              deployment email delivery may be disabled; the link is then written to the server log.
            </p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault();
                setPending(true);
                setError(null);
                try {
                  await api('/auth/password-reset/request', { body: { email } });
                  setSent(true);
                } catch (err) {
                  setError(err);
                } finally {
                  setPending(false);
                }
              }}
            >
              <Field label="Email" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              {error ? <ErrorBox error={error} /> : null}
              <Button type="submit" className="w-full" loading={pending}>
                Send reset link
              </Button>
            </form>
          )}
          <p className="mt-4 text-center text-sm">
            <Link href="/login" className="text-muted-foreground hover:text-foreground">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </>
  );
}

'use client';

import type { MeResponse } from '@agentforge/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ErrorBox } from '@/components/ui/misc';
import { api } from '@/lib/api';

const DEMO = { email: 'demo@agentforge.dev', password: 'agentforge-2026' };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(params.get('demo') ? DEMO.email : '');
  const [password, setPassword] = useState(params.get('demo') ? DEMO.password : '');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const next = params.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';

  async function signIn(credentials: { email: string; password: string }) {
    setPending(true);
    setError(null);
    try {
      const me = await api<MeResponse>('/auth/login', { body: credentials });
      queryClient.setQueryData(['me'], me);
      router.push(target);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">Welcome back to AgentForge.</p>
      <Card>
        <CardContent className="pt-5">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn({ email, password });
            }}
          >
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error ? <ErrorBox error={error} /> : null}
            <Button type="submit" className="w-full" loading={pending}>
              Sign in
            </Button>
          </form>
          <div className="mt-4 flex items-center justify-between text-sm">
            <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground">
              Forgot password?
            </Link>
            <Link href="/register" className="font-medium text-primary">
              Create account
            </Link>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 rounded-xl border border-primary/25 bg-primary-soft p-4 text-sm">
        <div className="flex items-center gap-2 font-medium text-primary">
          <Sparkles className="size-4" /> Live demo workspace
        </div>
        <p className="mt-1 text-muted-foreground">
          Sign in as the demo owner to explore a seeded organization with documents, agents, runs,
          approvals and evaluations.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={pending}
          onClick={() => void signIn(DEMO)}
        >
          Continue as demo user
        </Button>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {DEMO.email} · {DEMO.password}
        </p>
      </div>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

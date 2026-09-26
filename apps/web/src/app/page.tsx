'use client';

import type { MeResponse } from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BookOpen,
  FlaskConical,
  ListChecks,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { GithubIcon, Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { buttonVariants } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const FEATURES = [
  {
    icon: BookOpen,
    title: 'Grounded answers with citations',
    text: 'Upload Markdown, text or PDF. Documents are chunked, embedded and searched with hybrid retrieval; every answer cites the passages it used.',
  },
  {
    icon: Workflow,
    title: 'A real agent loop',
    text: 'Classify → plan → retrieve → call tools → validate → answer, as a checkpointed LangGraph workflow that survives restarts and retries.',
  },
  {
    icon: ShieldCheck,
    title: 'Humans approve side effects',
    text: 'Tools declare explicit capabilities. Anything that writes data waits for a person with the right role to approve or reject it.',
  },
  {
    icon: ListChecks,
    title: 'Run inspector',
    text: 'Every step, model call, token count, tool input and output, approval and error of every run, streamed live as it happens.',
  },
  {
    icon: FlaskConical,
    title: 'Evaluations and regressions',
    text: 'Datasets of expected behaviour run against pinned agent versions, scored by evaluators, compared with the previous run.',
  },
  {
    icon: ScrollText,
    title: 'Teams, roles and audit',
    text: 'Organizations, projects, four roles, tenant isolation in every query, and an append-only audit log of who did what.',
  },
];

export default function LandingPage() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/auth/me'),
    retry: false,
  });
  const signedIn = me.isSuccess;

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <nav className="flex items-center gap-2">
          <a
            href="/docs"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'hidden sm:inline-flex',
            )}
          >
            API docs
          </a>
          <a
            href="https://github.com/MontheranNabulsi/agentforge"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'hidden sm:inline-flex',
            )}
            target="_blank"
            rel="noreferrer"
          >
            <GithubIcon /> GitHub
          </a>
          <ThemeToggle />
          {signedIn ? (
            <Link href="/app" className={buttonVariants({ size: 'sm' })}>
              Open dashboard <ArrowRight />
            </Link>
          ) : (
            <Link href="/login" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Sign in
            </Link>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="py-16 sm:py-24">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" /> Open-source agent platform · Next.js ·
            Fastify · LangGraph · Postgres + pgvector
          </div>
          <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            AI agents your team can <span className="text-primary">trust, inspect and measure</span>
            .
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
            AgentForge answers from your documents with citations, uses tools only through explicit
            capabilities, asks a person before it changes anything, and records every step so you
            can see exactly why it did what it did.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={signedIn ? '/app' : '/login?demo=1'}
              className={buttonVariants({ size: 'lg' })}
            >
              {signedIn ? 'Open dashboard' : 'Try the live demo'} <ArrowRight />
            </Link>
            {!signedIn ? (
              <Link href="/register" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                Create your own workspace
              </Link>
            ) : null}
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            The demo signs you in to a seeded workspace. It runs on a deterministic demo model, so
            it works without any API key; connect Claude by setting{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">ANTHROPIC_API_KEY</code>.
          </p>
        </section>

        <section className="grid gap-4 pb-20 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-5">
              <div className="mb-3 inline-flex rounded-lg bg-primary-soft p-2 text-primary">
                <Icon className="size-5" />
              </div>
              <h2 className="font-medium">{title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        AgentForge · MIT licensed ·{' '}
        <a className="underline" href="/docs">
          REST API reference
        </a>{' '}
        ·{' '}
        <a className="underline" href="/health/ready">
          health
        </a>
      </footer>
    </div>
  );
}

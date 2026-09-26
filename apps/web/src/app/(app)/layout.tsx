'use client';

import { AppShell } from '@/components/app-shell';
import { Logo } from '@/components/logo';
import { Spinner } from '@/components/ui/misc';
import { useMe } from '@/lib/hooks';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (!me.isSuccess) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <Logo />
        <Spinner label={me.isError ? 'Redirecting to sign in…' : 'Loading your workspace…'} />
      </div>
    );
  }
  return <AppShell>{children}</AppShell>;
}

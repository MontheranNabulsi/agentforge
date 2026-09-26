'use client';

import type { OrganizationDto } from '@agentforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  Check,
  ChevronsUpDown,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  ScrollText,
  User,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from '@/components/ui/dropdown';
import { Field, Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { initials } from '@/lib/format';
import { canManage, useCurrentOrg, useMe, useOrgOverview, useOrgs } from '@/lib/hooks';
import { cn } from '@/lib/utils';

function NavLink({
  href,
  icon: Icon,
  children,
  active,
  badge,
}: {
  href: string;
  icon: typeof Activity;
  children: React.ReactNode;
  active: boolean;
  badge?: number | undefined;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        active
          ? 'bg-card font-medium text-foreground shadow-xs ring-1 ring-border'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{children}</span>
      {badge ? <Badge tone="warning">{badge}</Badge> : null}
    </Link>
  );
}

function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => api<OrganizationDto>('/orgs', { body: { name } }),
    onSuccess: async (org) => {
      await queryClient.invalidateQueries({ queryKey: ['orgs'] });
      onOpenChange(false);
      setName('');
      router.push(`/o/${org.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New organization"
        description="Organizations own projects, members and billing boundaries."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name" htmlFor="org-name">
            <Input
              id="org-name"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Robotics"
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={create.isPending}>
              Create organization
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const orgs = useOrgs();
  const { orgId, org, role, projectId } = useCurrentOrg();
  const overview = useOrgOverview(orgId);
  const [creatingOrg, setCreatingOrg] = useState(false);

  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.clear();
      router.push('/login');
    },
  });

  const projects = overview.data?.projects ?? [];
  const pending = overview.data?.pendingApprovals ?? 0;

  return (
    <div
      className="flex h-full flex-col gap-4 p-3"
      onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}
    >
      <div className="flex items-center justify-between px-1.5 pt-1">
        <Link href="/app">
          <Logo />
        </Link>
        <ThemeToggle />
      </div>

      <Dropdown>
        <DropdownTrigger asChild>
          <button className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left text-sm shadow-xs hover:bg-muted">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary-soft text-[11px] font-semibold text-primary">
              {org ? initials(org.name) : '…'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{org?.name ?? 'Loading…'}</span>
              <span className="block text-xs capitalize text-muted-foreground">{role ?? ''}</span>
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </button>
        </DropdownTrigger>
        <DropdownContent align="start" className="w-64">
          <DropdownLabel>Organizations</DropdownLabel>
          {(orgs.data ?? []).map((o) => (
            <DropdownItem key={o.id} onSelect={() => router.push(`/o/${o.id}`)}>
              <span className="flex-1 truncate">{o.name}</span>
              {o.id === orgId ? (
                <Check />
              ) : (
                <span className="text-xs capitalize text-muted-foreground">{o.role}</span>
              )}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem onSelect={() => setCreatingOrg(true)}>
            <Plus /> New organization
          </DropdownItem>
        </DropdownContent>
      </Dropdown>
      <CreateOrgDialog open={creatingOrg} onOpenChange={setCreatingOrg} />

      <nav className="space-y-0.5">
        {orgId ? (
          <>
            <NavLink
              href={`/o/${orgId}`}
              icon={LayoutDashboard}
              active={pathname === `/o/${orgId}`}
            >
              Dashboard
            </NavLink>
            <NavLink
              href={`/o/${orgId}/approvals`}
              icon={Inbox}
              active={pathname.startsWith(`/o/${orgId}/approvals`)}
              badge={pending}
            >
              Approvals
            </NavLink>
            <NavLink
              href={`/o/${orgId}/members`}
              icon={Users}
              active={pathname.startsWith(`/o/${orgId}/members`)}
            >
              Members
            </NavLink>
            {canManage(role) ? (
              <NavLink
                href={`/o/${orgId}/audit`}
                icon={ScrollText}
                active={pathname.startsWith(`/o/${orgId}/audit`)}
              >
                Audit log
              </NavLink>
            ) : null}
          </>
        ) : null}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-1 flex items-center justify-between px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Projects
          {canManage(role) && orgId ? (
            <Link
              href={`/o/${orgId}?new=project`}
              className="rounded p-0.5 hover:bg-muted hover:text-foreground"
              aria-label="New project"
            >
              <Plus className="size-3.5" />
            </Link>
          ) : null}
        </div>
        <div className="space-y-0.5">
          {projects.map((p) => (
            <NavLink key={p.id} href={`/p/${p.id}`} icon={FolderKanban} active={projectId === p.id}>
              {p.name}
            </NavLink>
          ))}
          {overview.isSuccess && projects.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">No projects yet</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-0.5 border-t border-border pt-3">
        <NavLink href="/system" icon={Activity} active={pathname === '/system'}>
          System status
        </NavLink>
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <BookOpen className="size-4" /> API reference
        </a>
        <Dropdown>
          <DropdownTrigger asChild>
            <button className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {me.data ? initials(me.data.user.name) : ''}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{me.data?.user.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {me.data?.user.email}
                </span>
              </span>
            </button>
          </DropdownTrigger>
          <DropdownContent align="start" className="w-56">
            <DropdownItem onSelect={() => router.push('/profile')}>
              <User /> Profile & security
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={() => logout.mutate()}>
              <LogOut /> Sign out
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-border bg-subtle lg:block">
        <Sidebar />
      </aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-subtle">
            <button
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
            >
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/90 px-4 py-2 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <Logo />
        </div>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

'use client';

import type {
  MeResponse,
  OrganizationDto,
  OrganizationOverviewDto,
  ProjectDto,
  Role,
} from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { api } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/auth/me'),
    staleTime: 60_000,
  });
}

export function useOrgs() {
  return useQuery({
    queryKey: ['orgs'],
    queryFn: () => api<OrganizationDto[]>('/orgs'),
    staleTime: 60_000,
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDto>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}

export function useOrgOverview(orgId: string | undefined) {
  return useQuery({
    queryKey: ['org-overview', orgId],
    queryFn: () => api<OrganizationOverviewDto>(`/orgs/${orgId}/overview`),
    enabled: Boolean(orgId),
    refetchInterval: 30_000,
  });
}

const LAST_ORG_KEY = 'agentforge:last-org';

function readLastOrg(): string | null {
  try {
    return window.localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

/** The organization in focus: from the URL, the open project, or the one used last. */
export function useCurrentOrg(): {
  orgId: string | undefined;
  org: OrganizationDto | undefined;
  role: Role | undefined;
  projectId: string | undefined;
} {
  const params = useParams<{ orgId?: string; projectId?: string }>();
  const pathname = usePathname();
  const orgs = useOrgs();
  const project = useProject(params.projectId);
  const fromUrl = params.orgId ?? project.data?.organizationId;
  const list = orgs.data ?? [];
  const remembered = typeof window !== 'undefined' ? readLastOrg() : null;
  const orgId =
    fromUrl ??
    (remembered && list.some((o) => o.id === remembered) ? remembered : undefined) ??
    // Prefer a shared organization over the personal "…'s workspace" one.
    [...list].sort(
      (a, b) => Number(a.name.endsWith('workspace')) - Number(b.name.endsWith('workspace')),
    )[0]?.id;

  useEffect(() => {
    if (fromUrl) {
      try {
        window.localStorage.setItem(LAST_ORG_KEY, fromUrl);
      } catch {
        // storage unavailable
      }
    }
  }, [fromUrl, pathname]);

  const org = list.find((o) => o.id === orgId);
  return { orgId, org, role: org?.role, projectId: params.projectId };
}

export const canManage = (role: Role | undefined) => role === 'owner' || role === 'admin';
export const canWrite = (role: Role | undefined) =>
  role === 'owner' || role === 'admin' || role === 'member';

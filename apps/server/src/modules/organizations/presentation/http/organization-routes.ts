import {
  AddMemberInput,
  AuditEventDto,
  AuditListQuery,
  ChangeMemberRoleInput,
  CreateOrganizationInput,
  Id,
  MemberDto,
  OrganizationDto,
  pageOf,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import type { AuditQueries } from '../../../audit';
import type { Role } from '../../domain/access-rules';
import type { OrganizationAccess } from '../../application/organization-access';
import type { OrganizationUseCases } from '../../application/organization-use-cases';
import type { MemberView, Organization } from '../../application/ports';

const toOrganizationDto = (org: Organization & { role: Role }) => ({
  id: org.id,
  name: org.name,
  slug: org.slug,
  role: org.role,
  createdAt: org.createdAt.toISOString(),
});

const toMemberDto = (member: MemberView) => ({
  userId: member.userId,
  name: member.name,
  email: member.email,
  role: member.role,
  joinedAt: member.joinedAt.toISOString(),
});

const OrgParams = z.object({ orgId: Id });
const MemberParams = z.object({ orgId: Id, userId: Id });

export function organizationRoutes(deps: {
  organizations: OrganizationUseCases;
  access: OrganizationAccess;
  auditQueries: AuditQueries;
}) {
  const { organizations, access, auditQueries } = deps;

  return async (api: App) => {
    api.get(
      '/orgs',
      {
        schema: {
          tags: ['organizations'],
          summary: 'Organizations you belong to',
          response: { 200: z.array(OrganizationDto) },
        },
      },
      async (request) =>
        (await organizations.listMine(requireActor(request))).map(toOrganizationDto),
    );

    api.post(
      '/orgs',
      {
        schema: {
          tags: ['organizations'],
          summary: 'Create an organization',
          body: CreateOrganizationInput,
          response: { 201: OrganizationDto },
        },
      },
      async (request, reply) => {
        const actor = { ...requireActor(request), name: request.auth!.user.name };
        const organization = await organizations.create(actor, request.body);
        return reply.status(201).send(toOrganizationDto(organization));
      },
    );

    api.get(
      '/orgs/:orgId',
      {
        schema: { tags: ['organizations'], params: OrgParams, response: { 200: OrganizationDto } },
      },
      async (request) =>
        toOrganizationDto(await organizations.get(requireActor(request), request.params.orgId)),
    );

    api.get(
      '/orgs/:orgId/members',
      {
        schema: {
          tags: ['organizations'],
          params: OrgParams,
          response: { 200: z.array(MemberDto) },
        },
      },
      async (request) =>
        (await organizations.listMembers(requireActor(request), request.params.orgId)).map(
          toMemberDto,
        ),
    );

    api.post(
      '/orgs/:orgId/members',
      {
        schema: {
          tags: ['organizations'],
          summary: 'Add an existing user to the organization',
          params: OrgParams,
          body: AddMemberInput,
          response: { 201: MemberDto },
        },
      },
      async (request, reply) => {
        const actor = { ...requireActor(request), name: request.auth!.user.name };
        const member = await organizations.addMember(actor, request.params.orgId, request.body);
        return reply.status(201).send(toMemberDto(member));
      },
    );

    api.patch(
      '/orgs/:orgId/members/:userId',
      {
        schema: {
          tags: ['organizations'],
          summary: 'Change a member role',
          params: MemberParams,
          body: ChangeMemberRoleInput,
          response: { 200: MemberDto },
        },
      },
      async (request) => {
        const actor = { ...requireActor(request), name: request.auth!.user.name };
        const member = await organizations.changeRole(
          actor,
          request.params.orgId,
          request.params.userId,
          request.body.role,
        );
        return toMemberDto(member);
      },
    );

    api.delete(
      '/orgs/:orgId/members/:userId',
      {
        schema: {
          tags: ['organizations'],
          summary: 'Remove a member (or leave)',
          params: MemberParams,
        },
      },
      async (request, reply) => {
        const actor = { ...requireActor(request), name: request.auth!.user.name };
        await organizations.removeMember(actor, request.params.orgId, request.params.userId);
        return reply.status(204).send();
      },
    );

    api.get(
      '/orgs/:orgId/audit-events',
      {
        schema: {
          tags: ['audit'],
          summary: 'Audit log (admins and owners)',
          params: OrgParams,
          querystring: AuditListQuery,
          response: { 200: pageOf(AuditEventDto) },
        },
      },
      async (request) => {
        const { orgId } = request.params;
        await access.require(requireActor(request), orgId, 'audit:read');
        const q = request.query;
        return auditQueries.list({
          organizationId: orgId,
          limit: q.limit,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.action ? { actionPrefix: q.action } : {}),
          ...(q.actorId ? { actorId: q.actorId } : {}),
        });
      },
    );
  };
}

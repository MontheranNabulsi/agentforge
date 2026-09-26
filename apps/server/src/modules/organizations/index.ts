/** Public API of the organizations module: tenancy, membership and the RBAC matrix. */
export {
  OrganizationAccess,
  type OrganizationAccessGrant,
} from './application/organization-access';
export { OrganizationUseCases, type OrganizationDeps } from './application/organization-use-cases';
export type { MemberView, Organization } from './application/ports';
export { can, ROLES, type Permission, type Role } from './domain/access-rules';
export {
  DrizzleMembershipRepository,
  DrizzleOrganizationRepository,
} from './infrastructure/drizzle-organization-repositories';
export { organizationRoutes } from './presentation/http/organization-routes';

/** Public API of the projects module. ProjectAccess is the authorization entry point for project data. */
export {
  ProjectAccess,
  ProjectUseCases,
  toProjectDto,
  type Project,
  type ProjectAccessGrant,
  type ProjectDeps,
  type ProjectRepository,
} from './application/project-use-cases';
export { DrizzleProjectRepository } from './infrastructure/drizzle-project-repository';
export { projectRoutes } from './presentation/http/project-routes';

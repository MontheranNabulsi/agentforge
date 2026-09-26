/** Public API of the identity module: the only file other modules may import. */
export { IdentityUseCases } from './application/identity-use-cases';
export type {
  AuthenticatedSession,
  ClientMeta,
  IdentityDeps,
} from './application/identity-use-cases';
export type { UserRegisteredHook } from './application/ports';
export type { User } from './domain/identity-rules';
export {
  DrizzleCredentialRepository,
  DrizzlePasswordResetRepository,
  DrizzleSessionRepository,
  DrizzleUserRepository,
} from './infrastructure/drizzle-identity-repositories';
export { identityRoutes, toUserDto } from './presentation/http/identity-routes';

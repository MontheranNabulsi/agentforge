/** Public API of the audit module. Every module records audit events through AuditLog. */
export { AuditLog, AuditQueries } from './application/audit-log';
export type { AuditEventRepository, AuditListFilter } from './application/audit-log';
export type { AuditAction, AuditActor, AuditEntry } from './domain/audit-entry';
export {
  DrizzleAuditEventRepository,
  toAuditEventDto,
} from './infrastructure/drizzle-audit-repository';

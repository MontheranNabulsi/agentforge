import type { AuditEventDto, Page } from '@agentforge/contracts';
import type { AuditEntry } from '../domain/audit-entry';

export interface AuditListFilter {
  organizationId: string;
  projectId?: string;
  actionPrefix?: string;
  actorId?: string;
  limit: number;
  cursor?: string;
}

export interface AuditEventRepository {
  /** Inserts in the caller's transaction, so the event commits with the change it records. */
  insert(entry: AuditEntry): Promise<void>;
  list(filter: AuditListFilter): Promise<Page<AuditEventDto>>;
  recent(organizationId: string, limit: number, projectId?: string): Promise<AuditEventDto[]>;
}

/** The write side other modules call. Kept tiny on purpose: audit must never be the reason a change fails. */
export class AuditLog {
  constructor(private readonly repository: AuditEventRepository) {}

  record(entry: AuditEntry): Promise<void> {
    return this.repository.insert(entry);
  }
}

export class AuditQueries {
  constructor(private readonly repository: AuditEventRepository) {}

  list(filter: AuditListFilter): Promise<Page<AuditEventDto>> {
    return this.repository.list(filter);
  }

  recent(organizationId: string, limit = 10, projectId?: string): Promise<AuditEventDto[]> {
    return this.repository.recent(organizationId, limit, projectId);
  }
}

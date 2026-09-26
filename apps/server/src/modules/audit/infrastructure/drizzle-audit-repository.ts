import type { AuditEventDto, Page } from '@agentforge/contracts';
import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import { auditEvents } from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { executor } from '../../../platform/database/transaction';
import { requestContext } from '../../../platform/observability/request-context';
import { newId } from '../../../shared-kernel/ids';
import { decodeCursor, toPage } from '../../../shared-kernel/pagination';
import type { AuditEntry } from '../domain/audit-entry';
import type { AuditEventRepository, AuditListFilter } from '../application/audit-log';

type Row = typeof auditEvents.$inferSelect;

export const toAuditEventDto = (row: Row): AuditEventDto => ({
  id: row.id,
  organizationId: row.organizationId,
  projectId: row.projectId,
  actorType: row.actorType as AuditEventDto['actorType'],
  actorId: row.actorId,
  actorName: row.actorName,
  onBehalfOfUserId: row.onBehalfOfUserId,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  metadata: row.metadata,
  requestId: row.requestId,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
});

export class DrizzleAuditEventRepository implements AuditEventRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async insert(entry: AuditEntry): Promise<void> {
    const ctx = requestContext.get();
    const createdAt = this.now();
    await executor(this.db)
      .insert(auditEvents)
      .values({
        id: newId(createdAt.getTime()),
        organizationId: entry.organizationId,
        projectId: entry.projectId ?? null,
        actorType: entry.actor.type,
        actorId: entry.actor.type === 'system' ? null : entry.actor.id,
        actorName: entry.actor.name ?? null,
        onBehalfOfUserId: entry.actor.type === 'agent' ? entry.actor.onBehalfOfUserId : null,
        action: entry.action,
        targetType: entry.target.type,
        targetId: entry.target.id ?? null,
        metadata: entry.metadata ?? {},
        requestId: ctx?.requestId ?? null,
        runId: entry.runId ?? ctx?.runId ?? null,
        ip: ctx?.ip ?? null,
        createdAt,
      });
  }

  async list(filter: AuditListFilter): Promise<Page<AuditEventDto>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [eq(auditEvents.organizationId, filter.organizationId)];
    if (filter.projectId) conditions.push(eq(auditEvents.projectId, filter.projectId));
    if (filter.actorId) conditions.push(eq(auditEvents.actorId, filter.actorId));
    if (filter.actionPrefix)
      conditions.push(like(auditEvents.action, `${filter.actionPrefix.replace(/[%_]/g, '')}%`));
    if (cursor) {
      conditions.push(
        or(
          lt(auditEvents.createdAt, cursor.createdAt),
          and(eq(auditEvents.createdAt, cursor.createdAt), lt(auditEvents.id, cursor.id)),
        )!,
      );
    }
    const rows = await executor(this.db)
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(filter.limit + 1);
    return toPage(rows, filter.limit, toAuditEventDto);
  }

  async recent(
    organizationId: string,
    limit: number,
    projectId?: string,
  ): Promise<AuditEventDto[]> {
    const conditions = [eq(auditEvents.organizationId, organizationId)];
    if (projectId) conditions.push(eq(auditEvents.projectId, projectId));
    const rows = await executor(this.db)
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit);
    return rows.map(toAuditEventDto);
  }
}

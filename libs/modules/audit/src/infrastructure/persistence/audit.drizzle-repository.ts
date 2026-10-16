import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, PagedResult } from '@platform';
import { auditLogs } from '../../../../../../db/schema/audit';
import { users } from '../../../../../../db/schema/identity';
import type { AuditLog, CreateAuditLogInput } from '../../domain/audit.types';
import type { IAuditRepository, AuditFilters } from '../../domain/ports/audit.repository';

@Injectable()
export class AuditDrizzleRepository implements IAuditRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(input: CreateAuditLogInput): Promise<void> {
    await this.db
      .insert(auditLogs)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        projectId: input.projectId,
        changes: input.changes,
        metadata: input.metadata ?? {},
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        sourceEventId: input.sourceEventId,
        // undefined -> the column default, now()
        occurredAt: input.occurredAt,
      })
      // When sourceEventId is non-null and already exists, silently skip the insert.
      // When null (direct service calls), no conflict occurs (NULL != NULL in PG).
      .onConflictDoNothing({ target: auditLogs.sourceEventId });
  }

  /**
   * The ONE predicate set for a workspace's audit page — shared by the page query and by
   * its `total`, deliberately.
   *
   * A count taken under different conditions than the rows is the mistake Velocity's
   * eligibility join made (see CLAUDE.md, "Eligibility must be counted in the SAME scope as
   * the measurement"): the footer would report the size of a set the page is not a window
   * onto, which is worse than reporting nothing. One builder makes them incapable of
   * disagreeing.
   */
  private buildConditions(workspaceId: string, filters: AuditFilters): SQL[] {
    const conditions: SQL[] = [eq(auditLogs.workspaceId, workspaceId)];
    if (filters.actorId) conditions.push(eq(auditLogs.actorId, filters.actorId));
    if (filters.resourceType) conditions.push(eq(auditLogs.resourceType, filters.resourceType));
    if (filters.resourceId) conditions.push(eq(auditLogs.resourceId, filters.resourceId));
    if (filters.projectId) conditions.push(eq(auditLogs.projectId, filters.projectId));
    if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
    if (filters.from) conditions.push(gte(auditLogs.occurredAt, filters.from));
    if (filters.to) conditions.push(lte(auditLogs.occurredAt, filters.to));
    return conditions;
  }

  /**
   * One page of a workspace's audit log, newest first, plus the size of the whole matching set.
   *
   * INDEX NOTE — `action` is the filter the Audit Log screen drives (P45-04), and
   * `ix_audit_workspace` is `(workspace_id, occurred_at)`, so an action-filtered page walks that
   * index backwards discarding non-matching rows until it has `limit` of them: worst case, the
   * whole workspace's history for a rare action. The count pays the same. `(workspace_id, action,
   * occurred_at DESC)` is the index that makes both a bounded scan; `ix_audit_actor` is
   * `(workspace_id, actor_id)` with no `occurred_at`, so the actor filter already sorts one
   * actor's rows rather than seeking — bounded by that actor's volume, which is why it was
   * acceptable to ship without one. Neither is added here (a migration number was owned
   * elsewhere this round); both are recorded so the next migration can take them together.
   */
  async listForWorkspace(
    workspaceId: string,
    filters: AuditFilters,
    args: { limit: number; offset: number },
  ): Promise<PagedResult<AuditLog>> {
    const conditions = this.buildConditions(workspaceId, filters);

    // Resolve the actor's display name/email from the users table at read time
    // (LEFT JOIN — a removed user leaves the row intact with null name), mirroring
    // the work-item activity log. A stored actorEmail on the row still wins so a
    // future write-time capture remains authoritative.
    const page = this.db
      .select({
        id: auditLogs.id,
        workspaceId: auditLogs.workspaceId,
        actorId: auditLogs.actorId,
        actorName: users.displayName,
        actorEmail: sql<string | null>`coalesce(${auditLogs.actorEmail}, ${users.email})`,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        projectId: auditLogs.projectId,
        changes: auditLogs.changes,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        userAgent: auditLogs.userAgent,
        occurredAt: auditLogs.occurredAt,
        sourceEventId: auditLogs.sourceEventId,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorId, users.id))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.occurredAt), asc(auditLogs.id))
      .limit(args.limit)
      .offset(args.offset);

    /**
     * `total` is the size of the REAL matching set, not of the page — the fact the Audit Log
     * screen had no way to state.
     *
     * P45-04: every filter on that screen is a claim about the whole log, and a reader who
     * cannot see how many rows matched cannot tell a filter that found three events from one
     * that searched fifty rows and found three. The footer prints it (`PaginationFooter.total`
     * / `pageCount`), so an Actor or Action filter returning nothing now says "0 of 0" for the
     * workspace rather than "nothing on this page".
     *
     * Counting the bare table is safe and cheap: every condition above constrains
     * `audit_logs` alone, and the row join is LEFT, so it cannot change the count.
     */
    const count = this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(...conditions));

    const [rows, [countRow]] = await Promise.all([page, count]);
    const total = Number(countRow?.total ?? 0);

    return {
      data: rows as AuditLog[],
      pageInfo: {
        // Derived from `total` rather than from a limit+1 probe, so the two can never
        // contradict each other ("1–50 of 50" beside an enabled Next). Sound because
        // `audit_logs` is APPEND-ONLY — nothing updates or deletes a row — so a count taken
        // beside the page can only be greater than or equal to what the page saw.
        hasNextPage: args.offset + rows.length < total,
        nextCursor: null, // audit uses offset pagination for simplicity
        limit: args.limit,
        total,
      },
    };
  }
}

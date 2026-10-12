export interface AuditLog {
  id: string;
  workspaceId: string;
  actorId: string | null;
  /** Actor's display name, resolved from the users table at read time. */
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  changes: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: Date;
  sourceEventId: string | null;
}

export interface CreateAuditLogInput {
  id: string;
  workspaceId: string;
  actorId?: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId?: string;
  changes?: { before?: unknown; after?: unknown };
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  /** Outbox eventId — used for at-most-once deduplication via ON CONFLICT DO NOTHING. */
  sourceEventId?: string;
  /**
   * When the event happened. Omitted for a direct call (the database stamps `now()`). The projection relay passes
   * the outbox row's `occurred_at`: it writes the audit row after claim, backoff and retries, which can be minutes
   * (hours, after an outage) later, and the audit trail must say when the thing happened, not when it was projected.
   */
  occurredAt?: Date;
}

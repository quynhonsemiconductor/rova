import { Injectable } from '@nestjs/common';
import type { SecurityEvent, SecurityEventSink } from '@quynhonsemiconductor/identity';
import { AuthMetrics } from '@quynhonsemiconductor/observability';
import { AuditService } from '@modules/audit';
import { HOME_WORKSPACE_ID } from './home-workspace';

/** The audit action for each identity event worth an audit row. Everything else is a metric and a log line only. */
const ACTION_BY_EVENT: Partial<Record<SecurityEvent['name'], string>> = {
  'sign_in.success': 'auth.login.sso',
  'sign_in.failure': 'auth.login.failed',
  'context.switched': 'auth.workspace.switched',
};

export function auditActionFor(event: SecurityEvent): string | undefined {
  return ACTION_BY_EVENT[event.name];
}

/**
 * Writes identity's sign-in events to rova's audit log. The workspace is the install's home workspace: a sign-in happens
 * before any workspace is active, exactly as under v7 (`auth.login.sso` was recorded against the workspace the login
 * resolved to). Ids and counts only, never an address.
 */
@Injectable()
export class SecurityEventAuditSink implements SecurityEventSink {
  constructor(
    private readonly audit: AuditService,
    private readonly authMetrics: AuthMetrics,
  ) {}

  async emit(event: SecurityEvent): Promise<void> {
    // `auth_login_total`: the counter the `auth-login-failure-rate` alert and the dashboard have always read. identity counts
    // the same events as `identity.security_events{event}`; this keeps the existing alert true across the cutover.
    if (event.name === 'sign_in.success') this.authMetrics.recordLogin('sso', 'success');
    if (event.name === 'sign_in.failure') this.authMetrics.recordLogin('sso', 'failure');
    const action = auditActionFor(event);
    if (!action) return;
    // `audit_logs.resource_id` is a uuid and a failed sign-in often names no user: that one is a metric and a log line.
    if (!event.userId) return;
    await this.audit.record({
      workspaceId: HOME_WORKSPACE_ID,
      actorId: event.userId,
      action,
      resourceType: 'user',
      resourceId: event.userId,
      ...(event.ip ? { ipAddress: event.ip } : {}),
      metadata: { ...(event.detail ?? {}) },
    });
  }
}

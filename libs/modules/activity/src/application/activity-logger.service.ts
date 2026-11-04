import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { requestContextStorage, type DbExecutor } from '@platform';
import {
  ACTIVITY_LOG_REPOSITORY,
  IActivityLogRepository,
} from '../domain/ports/activity-log.repository';
import type {
  ActivityChange,
  ActivityEntityType,
  ActivityPage,
  CreateActivityInput,
} from '../domain/activity-log.types';
import { diffFields, type ActivityDiffConfig } from '../domain/activity-diff';

/** Identifies the subject entity + where its history is anchored. */
export interface ActivitySubject {
  workspaceId: string;
  projectId: string;
  entityType: ActivityEntityType;
  entityId: string;
  /** Optional parent anchor (e.g. a task's parent work item). */
  contextId?: string | null;
}

/**
 * The single injectable every module uses to record Revision History. Writes are
 * ALWAYS batched (one INSERT). Pass `tx` to join the mutation's unit of work so
 * history is atomic with the change; use {@link logSafe} for non-critical side
 * events where a log failure must never fail the mutation.
 */
@Injectable()
export class ActivityLogger {
  private readonly logger = new Logger(ActivityLogger.name);

  constructor(@Inject(ACTIVITY_LOG_REPOSITORY) private readonly repo: IActivityLogRepository) {}

  /** Build one entry (does not persist). */
  build(
    subject: ActivitySubject,
    actorId: string | null,
    action: string,
    changes: ActivityChange | null = null,
    metadata: Record<string, unknown> = {},
  ): CreateActivityInput {
    return {
      id: uuidv7(),
      workspaceId: subject.workspaceId,
      projectId: subject.projectId,
      entityType: subject.entityType,
      entityId: subject.entityId,
      contextId: subject.contextId ?? null,
      actorId,
      action,
      changes,
      metadata,
    };
  }

  /** Build the entries for a field-diff (action per field via config, or `fallbackAction`). */
  buildDiff<T extends Record<string, unknown>>(
    subject: ActivitySubject,
    actorId: string | null,
    before: T,
    input: Partial<T>,
    config: ActivityDiffConfig<T>,
    fallbackAction: string,
  ): CreateActivityInput[] {
    return diffFields(before, input, config).map((e) =>
      this.build(subject, actorId, e.action ?? fallbackAction, e.change),
    );
  }

  /** Provenance: an MCP-bridged write stamps `metadata.source = 'mcp'` on every row it appends. */
  private withSource(inputs: CreateActivityInput[]): CreateActivityInput[] {
    const store = requestContextStorage.getStore() as { mcpBridged?: unknown } | undefined;
    if (store?.mcpBridged !== true) return inputs;
    return inputs.map((input) => ({
      ...input,
      metadata: { ...input.metadata, source: 'mcp' },
    }));
  }

  /** Batched append. `tx` → participates in the caller's transaction. Throws on failure. */
  async log(inputs: CreateActivityInput[], opts?: { tx?: DbExecutor }): Promise<void> {
    if (inputs.length === 0) return;
    await this.repo.appendMany(this.withSource(inputs), opts?.tx);
  }

  /** Best-effort append — a revision-log failure must never fail the mutation. */
  async logSafe(inputs: CreateActivityInput[], opts?: { tx?: DbExecutor }): Promise<void> {
    if (inputs.length === 0) return;
    try {
      await this.repo.appendMany(this.withSource(inputs), opts?.tx);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to write activity log');
    }
  }

  /** Newest-first history for one entity (own logs + child logs anchored to it). */
  listFor(entityId: string, workspaceId: string, page = 1, pageSize = 50): Promise<ActivityPage> {
    return this.repo.listFor(entityId, workspaceId, page, pageSize);
  }
}

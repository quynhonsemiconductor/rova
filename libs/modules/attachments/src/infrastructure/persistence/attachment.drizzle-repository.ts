import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB, DbExecutor } from '@platform';
import { attachments } from '../../../../../../db/schema/work';
import { files } from '../../../../../../db/schema/storage';
import type { AttachmentRef, EntityAttachment } from '../../domain/attachment.types';
import type { IAttachmentRepository } from '../../domain/ports/attachment.repository';

/**
 * Link-table repository. Every query joins storage.files and filters on
 * `status = 'completed'` + `deleted_at IS NULL`, so a presigned-but-unconfirmed
 * or soft-deleted file can never appear in a listing or count against quota.
 *
 * Keyed by `(entity_type, entity_id)` since migration 0083, so the same link table serves a
 * work item and a portfolio item. Every method takes the pair rather than a bare id: an id
 * alone is ambiguous now, and a default of "work_item" would silently mis-scope any caller
 * that forgot to say.
 */
@Injectable()
export class AttachmentDrizzleRepository implements IAttachmentRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private static readonly projection = {
    id: files.id,
    entityType: attachments.entityType,
    entityId: attachments.entityId,
    workspaceId: attachments.workspaceId,
    filename: files.filename,
    mimeType: files.mimeType,
    sizeBytes: files.sizeBytes,
    uploadedBy: files.uploadedBy,
    createdAt: attachments.createdAt,
  };

  /** The subject predicate. Both columns, always — see the class comment. */
  private static subject(ref: AttachmentRef, workspaceId: string) {
    return and(
      eq(attachments.entityType, ref.entityType),
      eq(attachments.entityId, ref.entityId),
      eq(attachments.workspaceId, workspaceId),
    );
  }

  async listByEntity(ref: AttachmentRef, workspaceId: string): Promise<EntityAttachment[]> {
    const rows = await this.db
      .select(AttachmentDrizzleRepository.projection)
      .from(attachments)
      .innerJoin(files, eq(files.id, attachments.fileId))
      .where(
        and(
          AttachmentDrizzleRepository.subject(ref, workspaceId),
          eq(files.status, 'completed'),
          isNull(files.deletedAt),
        ),
      )
      .orderBy(
        attachments.createdAt,
        // No surrogate id on this junction table — its composite PK is the
        // (entity_type, entity_id, file_id) triple, so that triple is the tiebreaker.
        asc(attachments.entityType),
        asc(attachments.entityId),
        asc(attachments.fileId),
      );
    // `entity_type` (migration 0129) admits `test_case` AND `test_result` at the DB level, but this
    // module's own `AttachmentRef` union only picked up `test_case` (Phase 7 plan §2.6, Phase C) —
    // `test_result` has no `UploadPolicy` descriptor yet (Phase D/E). The WHERE clause above filters
    // on `ref.entityType`, which is always one of THIS module's three members, so a row here can
    // never actually carry `test_result`; the cast is narrowing to what the query provably returns,
    // not widening what the module accepts.
    return rows as EntityAttachment[];
  }

  async countByEntity(ref: AttachmentRef, workspaceId: string): Promise<number> {
    const [{ cnt }] = await this.db
      .select({ cnt: count() })
      .from(attachments)
      .innerJoin(files, eq(files.id, attachments.fileId))
      .where(
        and(
          AttachmentDrizzleRepository.subject(ref, workspaceId),
          eq(files.status, 'completed'),
          isNull(files.deletedAt),
        ),
      );
    return Number(cnt);
  }

  async findByEntityAndFile(
    ref: AttachmentRef,
    fileId: string,
    workspaceId: string,
  ): Promise<EntityAttachment | null> {
    const rows = await this.db
      .select(AttachmentDrizzleRepository.projection)
      .from(attachments)
      .innerJoin(files, eq(files.id, attachments.fileId))
      .where(
        and(
          AttachmentDrizzleRepository.subject(ref, workspaceId),
          eq(attachments.fileId, fileId),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);
    // See the comment in `listByEntity` — narrowing, not widening.
    return (rows[0] as EntityAttachment | undefined) ?? null;
  }

  async link(
    input: {
      entityType: AttachmentRef['entityType'];
      entityId: string;
      fileId: string;
      workspaceId: string;
      attachedBy: string;
    },
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db).insert(attachments).values(input).onConflictDoNothing();
  }

  async unlink(
    ref: AttachmentRef,
    fileId: string,
    workspaceId: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db)
      .delete(attachments)
      .where(
        and(AttachmentDrizzleRepository.subject(ref, workspaceId), eq(attachments.fileId, fileId)),
      );
  }
}

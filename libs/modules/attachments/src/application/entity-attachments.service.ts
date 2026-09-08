import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  UnitOfWork,
} from '@platform';
import type { JwtPayload } from '@platform';
import { PERMISSION, permissionGrants } from '@shared-kernel';
import { AccessService } from '@modules/access';
import { ActivityLogger } from '@modules/activity';
import { AttachmentsService } from './attachments.service';
import { ENTITY_ATTACHMENT_POLICY } from '../domain/attachment-policy';
import type { UploadPolicy } from '../domain/attachment-policy';
import {
  ATTACHMENT_REPOSITORY,
  type IAttachmentRepository,
} from '../domain/ports/attachment.repository';
import type { AttachmentRef, EntityAttachment } from '../domain/attachment.types';

/**
 * Attachment mechanics for ANY entity that can own files — the part that was previously
 * inlined in `WorkItemsService` and is identical for a portfolio item.
 *
 * The split follows the rule this module already states: mechanics live here, ROUTES and
 * AUTHORIZATION stay with the owning context. So this service never resolves a permission
 * code from an entity type and never loads a work item or a portfolio item. Its callers
 * (`WorkItemsService`, `PortfolioAttachmentsController`) prove the subject exists, prove the
 * actor may touch it, and pass the resolved `projectId` in for the activity log.
 *
 * That is deliberate rather than lazy: an `entityType → permission` map inside here would be
 * exactly the "owner-type registry lookup" `AttachmentsModule`'s own doc comment warns
 * against, and it is where cross-entity authorization bugs hide.
 *
 * The one authorization decision that DOES live here is the delete rule — the uploader, the
 * owning project's Admin, or a workspace admin may remove a file. That rule is about the FILE,
 * not about the entity it hangs off, so it is the same rule everywhere and belongs in one place.
 * It takes the caller's resolved `projectId` for the level lookup, in the same argument it
 * already passed for the activity log — this service still resolves no entity of its own.
 */
@Injectable()
export class EntityAttachmentsService {
  private readonly logger = new Logger(EntityAttachmentsService.name);

  constructor(
    @Inject(ATTACHMENT_REPOSITORY) private readonly links: IAttachmentRepository,
    private readonly attachments: AttachmentsService,
    private readonly accessService: AccessService,
    private readonly activity: ActivityLogger,
    private readonly uow: UnitOfWork,
  ) {}

  async list(actor: JwtPayload, ref: AttachmentRef): Promise<EntityAttachment[]> {
    return this.links.listByEntity(ref, actor.workspaceId);
  }

  async presign(
    actor: JwtPayload,
    ref: AttachmentRef,
    input: { filename: string; mimeType: string; sizeBytes: number; checksumSha256: string },
    policy: UploadPolicy = ENTITY_ATTACHMENT_POLICY,
  ): Promise<{ attachmentId: string; uploadUrl: string; requiredHeaders: Record<string, string> }> {
    const current = await this.links.countByEntity(ref, actor.workspaceId);
    const { fileId, uploadUrl, requiredHeaders } = await this.attachments.presign(
      actor,
      policy,
      input,
      current,
    );
    return { attachmentId: fileId, uploadUrl, requiredHeaders };
  }

  async confirm(
    actor: JwtPayload,
    ref: AttachmentRef,
    attachmentId: string,
    projectId: string,
    policy: UploadPolicy = ENTITY_ATTACHMENT_POLICY,
  ): Promise<EntityAttachment> {
    // Verifies the object landed and matches the declared size + checksum.
    const file = await this.attachments.confirm(actor, attachmentId, policy);

    // Re-check the quota at confirm time: presign only reserved a row, and N concurrent
    // presigns could each have passed the check against the same count. This is the point
    // where the file becomes visible, so it is the point that has to hold the limit.
    const current = await this.links.countByEntity(ref, actor.workspaceId);
    if (current >= (policy.maxPerOwner ?? Infinity)) {
      await this.attachments.softDelete(attachmentId);
      throw new PreconditionFailedException(
        'ATTACHMENT_LIMIT_EXCEEDED',
        `This item already has the maximum of ${policy.maxPerOwner} attachments`,
      );
    }

    /**
     * The link row and its history are ONE write.
     *
     * Both of these were a repository call followed by a `void`-ed `logSafe`, so
     * `attachment.uploaded` was fire-and-forget OUTSIDE any transaction: the file became visible
     * and its Revision History entry could vanish with nothing but a warning in the log. Every
     * other activity and audit emit in this codebase takes the transaction handle
     * (`WorkItemsService`, `AccessService.assignRole`, …); these two were the exceptions, and an
     * attachment is exactly the kind of change a reader later needs attributed.
     *
     * `log`, not `logSafe`: inside a transaction a failed INSERT has already aborted it, so
     * swallowing the error would only move the failure to COMMIT and hide its cause.
     *
     * What stays outside, deliberately: `attachments.confirm` above verifies the object in the
     * bucket and flips `storage.files` to completed. Those are an S3 HEAD plus a write on a
     * different aggregate, and holding a Postgres transaction open across a network round-trip to
     * object storage is worse than the gap it would close — a file confirmed but unlinked is
     * already the reaper's job.
     */
    await this.uow.run(async (tx) => {
      await this.links.link(
        {
          entityType: ref.entityType,
          entityId: ref.entityId,
          fileId: attachmentId,
          workspaceId: actor.workspaceId,
          attachedBy: actor.sub,
        },
        tx,
      );
      await this.activity.log(
        [
          {
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            projectId,
            contextId: ref.entityId,
            entityType: 'attachment',
            entityId: attachmentId,
            actorId: actor.sub,
            action: 'attachment.uploaded',
            changes: null,
            metadata: { filename: file.filename },
          },
        ],
        { tx },
      );
    });
    this.logger.log({ ...ref, attachmentId, filename: file.filename }, 'Attachment confirmed');

    return {
      id: file.id,
      entityType: ref.entityType,
      entityId: ref.entityId,
      workspaceId: actor.workspaceId,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      uploadedBy: file.uploadedBy,
      createdAt: file.createdAt,
    };
  }

  async downloadUrl(
    actor: JwtPayload,
    ref: AttachmentRef,
    attachmentId: string,
    policy: UploadPolicy = ENTITY_ATTACHMENT_POLICY,
  ): Promise<{ downloadUrl: string }> {
    // Scoped to the ENTITY, not just the workspace: without this a viewer of item A could
    // mint a URL for an attachment on item B in a project they cannot see.
    const link = await this.links.findByEntityAndFile(ref, attachmentId, actor.workspaceId);
    if (!link) throw new NotFoundException('ATTACHMENT_NOT_FOUND', 'Attachment not found');

    const { url } = await this.attachments.getDownloadUrl(actor, attachmentId, policy);
    return { downloadUrl: url };
  }

  async delete(
    actor: JwtPayload,
    ref: AttachmentRef,
    attachmentId: string,
    projectId: string,
  ): Promise<void> {
    const link = await this.links.findByEntityAndFile(ref, attachmentId, actor.workspaceId);
    if (!link) throw new NotFoundException('ATTACHMENT_NOT_FOUND', 'Attachment not found');

    /**
     * Who may remove someone ELSE's file: a Workspace Admin, or the owning project's own Admin.
     *
     * It used to be the uploader or a Workspace Admin, full stop — so a per-Project Admin could not
     * clear a teammate's mis-uploaded or wrong-content file from their own project's work item, and
     * the only remedy was to escalate to a workspace-wide principal. §3.1's own summary is that
     * "`Admin` is powerful for delivery management", and an attachment on a work item is delivery
     * data: the same reason `project:edit` stays in the Admin set.
     *
     * The level is resolved through `AccessService.getProjectAccessLevel`, which filters the
     * synthesized assignments with `isProjectAccessLevel` — never a hand-written level list here.
     * A hand-written `'admin' | 'editor'` pair in two places is what once made a granted row read
     * as No Access, and the levels are one CHECK constraint, one permission map and one SPA mirror
     * that must move together.
     *
     * Written as an ALLOW-list (`=== 'admin'`), like `ProjectsService.listProjectMembers`: naming
     * the levels to REFUSE would admit every level added later by default, and a third level has
     * already been added and removed inside one week (migrations 0113, 0115).
     *
     * `null` here means the actor has no `project_members` row — a Workspace Admin (whose authority
     * is the workspace-wide grant) or No Access. The workspace check above already answers the
     * first, and the route's `work_item:view`/`:edit` gate refuses the second before this runs.
     */
    const isWorkspaceAdmin = permissionGrants(
      await this.accessService.getWorkspacePermissions(actor.sub, actor.workspaceId),
      PERMISSION.WORKSPACE_EDIT,
    );
    const level = await this.accessService.getProjectAccessLevel(
      actor.workspaceId,
      actor.sub,
      projectId,
    );
    const mayDeleteAnyFile = isWorkspaceAdmin || level === 'admin';
    if (!mayDeleteAnyFile && link.uploadedBy !== actor.sub) {
      throw new PermissionDeniedException(
        'ATTACHMENT_NOT_OWNER',
        'Only the uploader, a project admin or a workspace admin may delete this attachment',
      );
    }

    // Unlink + retire the file + record the history as ONE write — see `confirm` for why.
    // The object itself is removed by the worker reaper, which is the only place that can see
    // whether some other link row still references it.
    await this.uow.run(async (tx) => {
      await this.links.unlink(ref, attachmentId, actor.workspaceId, tx);
      await this.attachments.softDelete(attachmentId, tx);
      await this.activity.log(
        [
          {
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            projectId,
            contextId: ref.entityId,
            entityType: 'attachment',
            entityId: attachmentId,
            actorId: actor.sub,
            action: 'attachment.deleted',
            changes: null,
            metadata: { filename: link.filename },
          },
        ],
        { tx },
      );
    });
    this.logger.log({ ...ref, attachmentId, filename: link.filename }, 'Attachment deleted');
  }
}

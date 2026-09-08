import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
} from '@platform';
import type { JwtPayload } from '@platform';
import { PERMISSION } from '@shared-kernel';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { ICommentRepository, COMMENT_REPOSITORY } from '../domain/ports/comment.repository';
import type { Comment, CommentEntityType, CommentRef } from '../domain/collaboration.types';
import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';

@Injectable()
export class CollaborationService {
  private readonly logger = new Logger(CollaborationService.name);

  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly commentRepo: ICommentRepository,
    private readonly workItemsService: WorkItemsService,
    private readonly accessService: AccessService,
    private readonly portfolioItems: PortfolioItemsService,
    // Owns `assertProjectWritable` — the archived-project rule (PRJ-FR-010).
    private readonly projects: ProjectsService,
  ) {}

  /**
   * The owning project of a comment's subject — the one fact both collaboration gates need, and
   * the reason it is resolved in one place: a comment on a work item and a comment on a Feature
   * are the same rows in `collaboration.comments`, so the two ends must not resolve scope
   * differently.
   */
  private async subjectProjectId(actor: JwtPayload, ref: CommentRef): Promise<string> {
    this.assertCommentableEntity(ref.entityType);
    if (ref.entityType === 'work_item') {
      const item = await this.workItemsService.getWorkItem(actor.workspaceId, ref.entityId);
      return item.projectId;
    }
    const item = await this.portfolioItems.getItem(actor, ref.entityId);
    return item.projectId;
  }

  /**
   * Refuses `test_case` / `test_result` (plan §2.6/C7). `CommentEntityType` is derived from
   * `entity_ref_type`, so migration 0129's widening (Phase 7) admits both at the TYPE level even
   * though the SRS names no comment thread on either — the same enum also backs `attachments` and
   * `milestone_artifacts`, and CLAUDE.md's own warning is that a widened vocabulary must not
   * become a feature nobody designed. Without this, `subjectProjectId` would fall through to the
   * portfolio-item branch for a `test_case` ref (there is no third branch), resolving the WRONG
   * project rather than refusing outright.
   */
  private assertCommentableEntity(entityType: CommentEntityType): void {
    if (entityType === 'test_case' || entityType === 'test_result') {
      throw new PermissionDeniedException(
        'COMMENT_ENTITY_NOT_SUPPORTED',
        `Comments are not supported on a ${entityType}`,
      );
    }
  }

  /**
   * The subject must be REACHABLE by this caller, not merely in a project they can act in
   * (BA ruling 2026-08-17: enforce the Editor Team scope "consistently in API queries, lists,
   * reports, search, pickers and direct URLs").
   *
   * `@RequirePermission('work_item:view', { resource: 'work_item' })` on the route resolves the
   * PROJECT and nothing finer, so an Editor on one Team could read another Team's discussion — and the
   * Project Backlog's — through this door while the record itself was refused. A comment thread carries
   * the item's own conversation, so the leak is the same disclosure as the record.
   *
   * Only the work-item branch is team-scoped. A Portfolio Item is `portfolio:view`, which §3.2 withholds
   * from an Editor entirely, so the level check above is already the whole answer there — and the
   * ruling is about Work Items.
   */
  private async assertSubjectReachable(actor: JwtPayload, ref: CommentRef): Promise<void> {
    this.assertCommentableEntity(ref.entityType);
    if (ref.entityType !== 'work_item') return;
    const item = await this.workItemsService.getWorkItem(actor.workspaceId, ref.entityId);
    await this.accessService.assertTeamInScope(
      actor.workspaceId,
      actor.sub,
      item.projectId,
      item.teamId ?? null,
    );
  }

  /**
   * Authorize a collaboration write against the OWNING project of the subject.
   *
   * Resolving the subject's project makes commenting project-scoped like every other
   * write (a workspace-wide grant fast-paths; a project-scoped grant applies only to that
   * project). The PERMISSION differs by entity type, and deliberately so: a comment on a
   * story is a `work_item:edit` action, one on a Feature is `portfolio:edit`. Reusing a
   * single code would let someone who can only edit work items comment on the portfolio.
   *
   * An ARCHIVED project is refused here too (PRJ-FR-010). A comment is content: it renders on the
   * item's Discussion tab and notifies watchers and @mentions, so an archived project could still
   * be edited and could still generate mail. The check is a second call rather than something this
   * method open-codes — `ProjectsService.assertProjectWritable` is the only implementation.
   */
  private async assertCanCollaborate(actor: JwtPayload, ref: CommentRef): Promise<void> {
    const projectId = await this.subjectProjectId(actor, ref);
    await this.accessService.assertProjectPermission(
      actor,
      projectId,
      ref.entityType === 'work_item' ? PERMISSION.WORK_ITEM_EDIT : PERMISSION.PORTFOLIO_EDIT,
    );
    await this.assertSubjectReachable(actor, ref);
    await this.projects.assertProjectWritable(actor.workspaceId, projectId);
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  async listComments(actor: JwtPayload, ref: CommentRef): Promise<Comment[]> {
    // The READ needs the same reachability check as the write: the route's own guard stops at the
    // project. See {@link assertSubjectReachable}.
    await this.assertSubjectReachable(actor, ref);
    return this.commentRepo.listByEntity(ref, actor.workspaceId);
  }

  async createComment(
    actor: JwtPayload,
    ref: CommentRef,
    body: string,
    parentId?: string,
    mentionedUserIds: string[] = [],
  ): Promise<Comment> {
    // Authorization (work_item:edit on the item's project) is enforced by the
    // PolicyGuard on POST .../comments; update/delete stay service-checked below
    // because their subject is the loaded comment's own work item, not the path.
    //
    // The archived-project rule has no route decorator to lean on, so it is checked here — and only
    // that half, not the permission, which the guard has already decided. `subjectProjectId` is
    // the same resolve `assertCanCollaborate` uses, so create cannot end up scoped differently
    // from the edit and delete of the row it produces.
    await this.projects.assertProjectWritable(
      actor.workspaceId,
      await this.subjectProjectId(actor, ref),
    );
    const comment = await this.commentRepo.create({
      id: uuidv7(),
      workspaceId: actor.workspaceId,
      entityType: ref.entityType,
      entityId: ref.entityId,
      authorId: actor.sub,
      body,
      parentId,
    });
    this.logger.log(
      { commentId: comment.id, entityType: ref.entityType, entityId: ref.entityId },
      'Comment created',
    );
    // F7 — notify watchers/assignee (comment) and any @mentioned users. Best-effort
    // and awaited (not fire-and-forget): a notification failure must never fail
    // the comment write, but it must be logged rather than silently discarded —
    // otherwise a broken notification path has no signal anywhere.
    // Work items only: the notification fans out to watchers and the assignee, and a
    // portfolio item has neither yet. Silently skipping is right — the alternative is a
    // notification path that resolves nobody and logs a warning on every comment.
    if (ref.entityType === 'work_item') {
      await this.workItemsService
        .notifyCommentAdded(actor, ref.entityId, mentionedUserIds)
        .catch((err: unknown) =>
          this.logger.warn(
            { err, commentId: comment.id, workItemId: ref.entityId },
            'Failed to enqueue comment notifications',
          ),
        );
    }
    return comment;
  }

  async updateComment(actor: JwtPayload, commentId: string, body: string): Promise<Comment> {
    const comment = await this.commentRepo.findById(commentId);
    if (!comment || comment.workspaceId !== actor.workspaceId || comment.deletedAt) {
      throw new NotFoundException('COMMENT_NOT_FOUND', 'Comment not found');
    }
    if (comment.authorId !== actor.sub) {
      throw new PreconditionFailedException(
        'COMMENT_NOT_OWNED',
        'You can only edit your own comments',
      );
    }
    await this.assertCanCollaborate(actor, {
      entityType: comment.entityType,
      entityId: comment.entityId,
    });
    return this.commentRepo.update(commentId, body);
  }

  async deleteComment(actor: JwtPayload, commentId: string): Promise<void> {
    const comment = await this.commentRepo.findById(commentId);
    if (!comment || comment.workspaceId !== actor.workspaceId || comment.deletedAt) {
      throw new NotFoundException('COMMENT_NOT_FOUND', 'Comment not found');
    }
    if (comment.authorId !== actor.sub) {
      throw new PreconditionFailedException(
        'COMMENT_NOT_OWNED',
        'You can only delete your own comments',
      );
    }
    await this.assertCanCollaborate(actor, {
      entityType: comment.entityType,
      entityId: comment.entityId,
    });
    await this.commentRepo.softDelete(commentId);
  }
}

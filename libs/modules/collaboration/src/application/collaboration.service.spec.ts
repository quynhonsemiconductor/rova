import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { PreconditionFailedException } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { ActivityLogger } from '@modules/activity';
import { CollaborationService } from './collaboration.service';
import { COMMENT_REPOSITORY } from '../domain/ports/comment.repository';
import type { Comment } from '../domain/collaboration.types';

const now = new Date('2024-06-01');

const mockActor = {
  sub: 'user-1',
  workspaceId: 'ws-1',
  contextId: 'ws-1',
  sessionId: 's1',
  jti: 'j1',
  iat: 0,
  exp: 0,
  iss: 'rova',
  aud: 'rova-app',
  permissions: [] as string[],
  claims: { permissions: [] as string[] },
  authMethod: 'sso' as const,
};

const mockComment = (o: Partial<Comment> = {}): Comment => ({
  id: 'c-1',
  workspaceId: 'ws-1',
  entityType: 'work_item',
  entityId: 'wi-1',
  authorId: 'user-1',
  body: 'hello',
  parentId: null,
  isEdited: false,
  editedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  ...o,
});

const makeCommentRepo = () => ({
  findById: vi.fn(),
  listByEntity: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockImplementation((input) => Promise.resolve(mockComment(input))),
  update: vi.fn().mockImplementation((id, body) => Promise.resolve(mockComment({ id, body }))),
  softDelete: vi.fn().mockResolvedValue(undefined),
});

// getWorkItem resolves the item so the service can read its projectId.
const makeWorkItemsService = () => ({
  getWorkItem: vi.fn().mockResolvedValue({ id: 'wi-1', projectId: 'proj-9', workspaceId: 'ws-1' }),
  notifyCommentAdded: vi.fn().mockResolvedValue(undefined),
});

// getItem is the portfolio counterpart of getWorkItem — same job, different table.
const makePortfolioItemsService = () => ({
  getItem: vi.fn().mockResolvedValue({ id: 'pi-1', projectId: 'proj-7', workspaceId: 'ws-1' }),
});

const makeAccessService = () => ({
  assertProjectPermission: vi.fn().mockResolvedValue(undefined),
  // The Editor Team scope (BA ruling 2026-08-17): a comment thread is as reachable as its item, and
  // the route's guard stops at the project. Passes by default; the case about it says otherwise.
  assertTeamInScope: vi.fn().mockResolvedValue(undefined),
});

// The ONE home of PRJ-FR-010. Resolves by default; the block about it rejects deliberately.
const makeProjectsService = () => ({
  assertProjectWritable: vi
    .fn()
    .mockResolvedValue({ id: 'proj-9', workspaceId: 'ws-1', status: 'active' }),
  // The @mention allow-list: who can own work in the SUBJECT's project. Empty by default; the
  // mention cases below seed it.
  listProjectMemberOptions: vi.fn().mockResolvedValue([]),
});

const makeActivityLogger = () => ({
  build: vi.fn(
    (
      subject: Record<string, unknown>,
      actorId: string | null,
      action: string,
      changes: unknown = null,
      metadata: Record<string, unknown> = {},
    ) => ({ id: 'act', ...subject, actorId, action, changes, metadata }),
  ),
  logSafe: vi.fn().mockResolvedValue(undefined),
});

const WORK_ITEM_REF = { entityType: 'work_item' as const, entityId: 'wi-1' };
const PORTFOLIO_REF = { entityType: 'portfolio_item' as const, entityId: 'pi-1' };

describe('CollaborationService — project-scoped comment writes', () => {
  let service: CollaborationService;
  let commentRepo: ReturnType<typeof makeCommentRepo>;
  let workItemsService: ReturnType<typeof makeWorkItemsService>;
  let portfolioItemsService: ReturnType<typeof makePortfolioItemsService>;
  let accessService: ReturnType<typeof makeAccessService>;
  let projectsService: ReturnType<typeof makeProjectsService>;
  let activity: ReturnType<typeof makeActivityLogger>;

  beforeEach(async () => {
    commentRepo = makeCommentRepo();
    workItemsService = makeWorkItemsService();
    portfolioItemsService = makePortfolioItemsService();
    accessService = makeAccessService();
    projectsService = makeProjectsService();
    activity = makeActivityLogger();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollaborationService,
        { provide: COMMENT_REPOSITORY, useValue: commentRepo },
        { provide: WorkItemsService, useValue: workItemsService },
        { provide: PortfolioItemsService, useValue: portfolioItemsService },
        { provide: AccessService, useValue: accessService },
        { provide: ProjectsService, useValue: projectsService },
        { provide: ActivityLogger, useValue: activity },
      ],
    }).compile();

    service = module.get(CollaborationService);
  });

  describe('createComment', () => {
    // POST .../comments is now authorized by the PolicyGuard (work_item:edit on
    // the path workItemId's project); the service just writes the comment.
    it('creates the comment without a service-level project check', async () => {
      await service.createComment(mockActor, WORK_ITEM_REF, 'hi');
      expect(commentRepo.create).toHaveBeenCalledOnce();
      expect(accessService.assertProjectPermission).not.toHaveBeenCalled();
    });

    it('stores the entity pair it was given', async () => {
      await service.createComment(mockActor, PORTFOLIO_REF, 'hi');
      expect(commentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'portfolio_item', entityId: 'pi-1' }),
      );
    });

    /**
     * A reply may only attach to a comment on the SAME subject, in the SAME workspace, that is
     * still live. Without the check a client could thread a reply under another item's (or
     * another workspace's) comment and the thread view would render a parent the reader cannot
     * open. Each condition is a separate case, because the guard is one boolean and a test that
     * only exercises the item mismatch would not notice the workspace half disappearing.
     */
    describe('COMMENT_PARENT_MISMATCH', () => {
      it('refuses a parent comment on another work item', async () => {
        commentRepo.findById.mockResolvedValue(mockComment({ entityId: 'wi-2' }));

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'reply', 'c-1'),
        ).rejects.toMatchObject({ code: 'COMMENT_PARENT_MISMATCH' });
        expect(commentRepo.create).not.toHaveBeenCalled();
      });

      it('refuses a parent comment from ANOTHER workspace, same item id', async () => {
        // The entity pair matches; only the workspace differs. A cross-workspace id must not be
        // reachable through a same-id item (workspaces share no id space, but the check is the
        // contract, not the coincidence).
        commentRepo.findById.mockResolvedValue(mockComment({ workspaceId: 'ws-2' }));

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'reply', 'c-1'),
        ).rejects.toMatchObject({ code: 'COMMENT_PARENT_MISMATCH' });
        expect(commentRepo.create).not.toHaveBeenCalled();
      });

      it('refuses a parent comment that was soft-deleted', async () => {
        commentRepo.findById.mockResolvedValue(mockComment({ deletedAt: now }));

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'reply', 'c-1'),
        ).rejects.toMatchObject({ code: 'COMMENT_PARENT_MISMATCH' });
        expect(commentRepo.create).not.toHaveBeenCalled();
      });

      it('refuses a parent of the other entity type (a portfolio comment on a work item)', async () => {
        commentRepo.findById.mockResolvedValue(
          mockComment({ entityType: 'portfolio_item', entityId: 'wi-1' }),
        );

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'reply', 'c-1'),
        ).rejects.toMatchObject({ code: 'COMMENT_PARENT_MISMATCH' });
        expect(commentRepo.create).not.toHaveBeenCalled();
      });

      it('refuses a parent id that does not exist', async () => {
        commentRepo.findById.mockResolvedValue(null);

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'reply', 'c-missing'),
        ).rejects.toMatchObject({ code: 'COMMENT_PARENT_MISMATCH' });
        expect(commentRepo.create).not.toHaveBeenCalled();
      });

      it('accepts a live parent on the same subject and stores its id', async () => {
        commentRepo.findById.mockResolvedValue(mockComment());

        await service.createComment(mockActor, WORK_ITEM_REF, 'reply', 'c-1');
        expect(commentRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ parentId: 'c-1' }),
        );
        expect(projectsService.listProjectMemberOptions).not.toHaveBeenCalled();
      });
    });

    /**
     * @mentions are restricted to people who can own work in the SUBJECT's project, and the
     * allow-list is the project-scoped picker feed read with the CALLER's workspace. An id from
     * another project or another workspace must not become a notification target.
     */
    describe('COMMENT_MENTION_NOT_IN_PROJECT', () => {
      it('refuses an id outside the project member feed and writes nothing', async () => {
        projectsService.listProjectMemberOptions.mockResolvedValue([{ userId: 'user-2' }]);

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'hi', undefined, ['outsider-1']),
        ).rejects.toMatchObject({ code: 'COMMENT_MENTION_NOT_IN_PROJECT' });
        expect(projectsService.listProjectMemberOptions).toHaveBeenCalledWith('ws-1', 'proj-9');
        expect(commentRepo.create).not.toHaveBeenCalled();
        expect(workItemsService.notifyCommentAdded).not.toHaveBeenCalled();
      });

      it('refuses when only ONE of several mentions is an outsider', async () => {
        projectsService.listProjectMemberOptions.mockResolvedValue([
          { userId: 'user-2' },
          { userId: 'user-3' },
        ]);

        await expect(
          service.createComment(mockActor, WORK_ITEM_REF, 'hi', undefined, [
            'user-2',
            'outsider-1',
          ]),
        ).rejects.toMatchObject({ code: 'COMMENT_MENTION_NOT_IN_PROJECT' });
        expect(commentRepo.create).not.toHaveBeenCalled();
      });

      it('reads the feed for the subject project, in the CALLER workspace', async () => {
        await service.createComment(mockActor, PORTFOLIO_REF, 'hi', undefined, []);

        // No mentions: the feed is never read.
        expect(projectsService.listProjectMemberOptions).not.toHaveBeenCalled();

        projectsService.listProjectMemberOptions.mockResolvedValue([{ userId: 'user-2' }]);
        await service.createComment(mockActor, PORTFOLIO_REF, 'hi', undefined, ['user-2']);

        // A portfolio subject resolves its own project (proj-7), and the read is workspace-scoped.
        expect(projectsService.listProjectMemberOptions).toHaveBeenCalledWith('ws-1', 'proj-7');
        expect(commentRepo.create).toHaveBeenCalledTimes(2);
      });

      it('accepts every mention that is in the feed', async () => {
        projectsService.listProjectMemberOptions.mockResolvedValue([
          { userId: 'user-2' },
          { userId: 'user-3' },
        ]);

        await service.createComment(mockActor, WORK_ITEM_REF, 'hi', undefined, [
          'user-2',
          'user-3',
        ]);
        expect(commentRepo.create).toHaveBeenCalledOnce();
        expect(workItemsService.notifyCommentAdded).toHaveBeenCalledWith(mockActor, 'wi-1', [
          'user-2',
          'user-3',
        ]);
      });
    });

    // notifyCommentAdded fans out to watchers and the assignee. A portfolio item has
    // neither, so the notification is skipped rather than resolving nobody.
    it('notifies on a work item and stays silent on a portfolio item', async () => {
      await service.createComment(mockActor, WORK_ITEM_REF, 'hi');
      expect(workItemsService.notifyCommentAdded).toHaveBeenCalledOnce();

      workItemsService.notifyCommentAdded.mockClear();
      await service.createComment(mockActor, PORTFOLIO_REF, 'hi');
      expect(workItemsService.notifyCommentAdded).not.toHaveBeenCalled();
    });
  });

  describe('updateComment', () => {
    it('authorizes the project after the owner check', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await service.updateComment(mockActor, 'c-1', 'edited');
      expect(accessService.assertProjectPermission).toHaveBeenCalledWith(
        mockActor,
        'proj-9',
        'work_item:edit',
      );
      expect(commentRepo.update).toHaveBeenCalledWith('c-1', 'edited');
    });

    // The permission code follows the subject, not the route. A grant to edit work items
    // must not carry over to the portfolio, so this asserts the two branches differ.
    it('authorizes a portfolio comment with portfolio:edit, not work_item:edit', async () => {
      commentRepo.findById.mockResolvedValue(
        mockComment({ entityType: 'portfolio_item', entityId: 'pi-1' }),
      );
      await service.updateComment(mockActor, 'c-1', 'edited');
      expect(portfolioItemsService.getItem).toHaveBeenCalledWith(mockActor, 'pi-1');
      expect(workItemsService.getWorkItem).not.toHaveBeenCalled();
      expect(accessService.assertProjectPermission).toHaveBeenCalledWith(
        mockActor,
        'proj-7',
        'portfolio:edit',
      );
    });

    it('rejects editing another user’s comment before touching authorization', async () => {
      commentRepo.findById.mockResolvedValue(mockComment({ authorId: 'someone-else' }));
      await expect(service.updateComment(mockActor, 'c-1', 'edited')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(accessService.assertProjectPermission).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('authorizes the project before soft-deleting, then records the delete (G6)', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await service.deleteComment(mockActor, 'c-1');
      expect(accessService.assertProjectPermission).toHaveBeenCalledWith(
        mockActor,
        'proj-9',
        'work_item:edit',
      );
      expect(commentRepo.softDelete).toHaveBeenCalledWith('c-1');
      expect(activity.logSafe).toHaveBeenCalledWith([
        expect.objectContaining({
          entityType: 'work_item',
          entityId: 'wi-1',
          action: 'comment.deleted',
          metadata: { commentId: 'c-1' },
        }),
      ]);
    });
  });

  /**
   * PRJ-03. None of the three comment writes carried the archived-project rule (PRJ-FR-010), so an
   * archived project's Discussion tab stayed fully writable — and a new comment still notified
   * watchers and @mentions, which means archiving did not even stop the mail.
   *
   * `createComment` reaches the rule through `subjectProjectId`, the same resolve
   * `assertCanCollaborate` uses, so create cannot end up scoped differently from the edit and
   * delete of the row it produces. Both entity types are covered because both write the same
   * `collaboration.comments` rows.
   */
  describe('an archived project refuses comment writes (PRJ-FR-010)', () => {
    beforeEach(() => {
      projectsService.assertProjectWritable.mockRejectedValue(
        new PreconditionFailedException('PROJECT_ARCHIVED', 'archived'),
      );
    });

    it('refuses a new comment on a work item', async () => {
      await expect(service.createComment(mockActor, WORK_ITEM_REF, 'hi')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(commentRepo.create).not.toHaveBeenCalled();
      expect(workItemsService.notifyCommentAdded).not.toHaveBeenCalled();
    });

    it('refuses a new comment on a portfolio item, resolved from the Feature', async () => {
      await expect(service.createComment(mockActor, PORTFOLIO_REF, 'hi')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(portfolioItemsService.getItem).toHaveBeenCalledWith(mockActor, 'pi-1');
      expect(commentRepo.create).not.toHaveBeenCalled();
    });

    it('refuses an edit', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await expect(service.updateComment(mockActor, 'c-1', 'edited')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(commentRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a delete', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await expect(service.deleteComment(mockActor, 'c-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(commentRepo.softDelete).not.toHaveBeenCalled();
    });

    it('still LISTS the thread — archived is read-only, not invisible', async () => {
      await expect(service.listComments(mockActor, WORK_ITEM_REF)).resolves.toEqual([]);
    });
  });

  /**
   * The Editor Team scope reaches the DISCUSSION too (BA ruling 2026-08-17: enforce it "consistently
   * in API queries, lists, reports, search, pickers and direct URLs").
   *
   * `@RequirePermission('work_item:view', { resource: 'work_item' })` resolves the PROJECT and nothing
   * finer, so without this an Editor on one Team could read another Team's thread — or the Project
   * Backlog's — through a door the record itself refuses. Asserted on the READ as well as the write,
   * because the read is the disclosure.
   */
  describe('a thread is only as reachable as its work item', () => {
    const denied = Object.assign(new Error('nope'), { code: 'TEAM_NOT_IN_SCOPE' });

    it('refuses to LIST when the item is out of the caller’s Team scope', async () => {
      accessService.assertTeamInScope.mockRejectedValueOnce(denied);

      await expect(service.listComments(mockActor, WORK_ITEM_REF)).rejects.toMatchObject({
        code: 'TEAM_NOT_IN_SCOPE',
      });
      expect(commentRepo.listByEntity).not.toHaveBeenCalled();
    });

    it('refuses to WRITE for the same reason', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      accessService.assertTeamInScope.mockRejectedValueOnce(denied);

      await expect(service.updateComment(mockActor, 'c-1', 'edited')).rejects.toMatchObject({
        code: 'TEAM_NOT_IN_SCOPE',
      });
      expect(commentRepo.update).not.toHaveBeenCalled();
    });

    it('does NOT team-scope a portfolio comment — that surface is portfolio:view', async () => {
      // §3.2 withholds Portfolio from an Editor entirely, so the level check is the whole answer
      // there, and the ruling is about Work Items.
      await service.listComments(mockActor, PORTFOLIO_REF);

      expect(accessService.assertTeamInScope).not.toHaveBeenCalled();
    });
  });

  /**
   * Phase 7 plan §2.6/C7: `entity_ref_type` (migration 0129) admits `test_case` / `test_result` at
   * the DB level, and `CommentEntityType` is DERIVED from that enum — so both reach this service's
   * TYPE signature even though the SRS names no comment thread on either. Without an explicit
   * refusal, `subjectProjectId`/`assertSubjectReachable` have only two branches and would silently
   * route a `test_case` ref into the PORTFOLIO branch (there is no third case) — the widened enum
   * becoming a feature nobody designed, which is exactly CLAUDE.md's warning about this class of
   * change.
   */
  describe('refuses comments on the two new Phase 7 entity kinds (C7)', () => {
    const TEST_CASE_REF = { entityType: 'test_case' as const, entityId: 'tc-1' };
    const TEST_RESULT_REF = { entityType: 'test_result' as const, entityId: 'tr-1' };

    it.each([
      ['test_case', TEST_CASE_REF],
      ['test_result', TEST_RESULT_REF],
    ])('refuses listComments for a %s ref', async (_label, ref) => {
      await expect(service.listComments(mockActor, ref)).rejects.toMatchObject({
        code: 'COMMENT_ENTITY_NOT_SUPPORTED',
      });
      expect(commentRepo.listByEntity).not.toHaveBeenCalled();
      expect(portfolioItemsService.getItem).not.toHaveBeenCalled();
    });

    it.each([
      ['test_case', TEST_CASE_REF],
      ['test_result', TEST_RESULT_REF],
    ])('refuses createComment for a %s ref', async (_label, ref) => {
      await expect(service.createComment(mockActor, ref, 'hello')).rejects.toMatchObject({
        code: 'COMMENT_ENTITY_NOT_SUPPORTED',
      });
      expect(commentRepo.create).not.toHaveBeenCalled();
      expect(portfolioItemsService.getItem).not.toHaveBeenCalled();
    });
  });
});

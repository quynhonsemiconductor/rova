import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DRIZZLE, NotFoundException, PreconditionFailedException, UnitOfWork } from '@platform';
import type { JwtPayload } from '@platform';
import { AccessService } from '@modules/access';
import { ActivityLogger } from '@modules/activity';
import { ProjectsService } from '@modules/projects';
import { PortfolioItemsService } from './portfolio-items.service';
import { PreliminaryEstimateMapService } from './preliminary-estimate-map.service';
import { DEFAULT_PRELIMINARY_ESTIMATE_MAP } from '../../../../../db/schema/enums';
import {
  PORTFOLIO_ITEM_REPOSITORY,
  type IPortfolioItemRepository,
} from '../domain/ports/portfolio-item.repository';
import type { PortfolioItemView } from '../domain/portfolio-item.types';

const WORKSPACE = 'ws-1';
const actor = { sub: 'user-1', workspaceId: WORKSPACE } as JwtPayload;

const view = (over: Partial<PortfolioItemView> = {}): PortfolioItemView => ({
  id: 'pi-1',
  workspaceId: WORKSPACE,
  projectId: 'proj-a',
  itemKey: 'FE-1',
  type: 'feature',
  name: 'A feature',
  description: null,
  notes: null,
  releaseNotes: null,
  whatSuccessLooksLike: null,
  state: 'developing',
  preliminaryEstimate: 'm',
  refinedEstimate: '0',
  refinedItemCountEstimate: 0,
  parentId: null,
  teamId: null,
  releaseId: null,
  ownerId: null,
  plannedStartDate: null,
  plannedEndDate: null,
  marketReleaseDate: null,
  rank: 'a',
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ownerName: null,
  teamName: null,
  releaseName: null,
  projectName: null,
  parentKey: null,
  childFeatureCount: 0,
  rollup: {
    portfolioItemId: 'pi-1',
    rollupPoints: 40,
    rollupCount: 2,
    acceptedPoints: 10,
    acceptedCount: 1,
    completedPoints: 10,
    completedCount: 1,
  },
  ...over,
});

const emptyPage = <T>(data: T[]) => ({
  data,
  pageInfo: { nextCursor: null, hasNextPage: false, limit: 50 },
});

describe('PortfolioItemsService', () => {
  let service: PortfolioItemsService;
  let repo: Mocked<IPortfolioItemRepository>;
  let access: Mocked<AccessService>;
  let maps: Mocked<PreliminaryEstimateMapService>;
  let activity: Mocked<ActivityLogger>;
  let projects: Mocked<ProjectsService>;
  /**
   * Rows returned to the Release/Team EXISTENCE checks in `assertReferences`.
   *
   * Defaults to one row so a reference resolves — tests about a MISSING reference set it
   * to `[]` explicitly. (This used to be `settingsRows`, back when the service read the
   * preliminary-estimate map straight from the database; `PreliminaryEstimateMapService`
   * is its own mock now, so the only remaining consumer of this chain is the reference
   * check.)
   */
  let referenceRows: Array<{ id: string }>;

  beforeEach(async () => {
    referenceRows = [{ id: 'ref-1' }];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioItemsService,
        {
          provide: PORTFOLIO_ITEM_REPOSITORY,
          useValue: {
            findById: vi.fn(),
            findViewById: vi.fn(),
            listByFilter: vi.fn().mockResolvedValue(emptyPage([])),
            rollupsFor: vi.fn().mockResolvedValue([]),
            listChildren: vi.fn().mockResolvedValue(emptyPage([])),
            listChildFeatures: vi.fn().mockResolvedValue([]),
            listFeatureOptions: vi.fn().mockResolvedValue([]),
            childRollupByType: vi.fn().mockResolvedValue([]),
            listMilestones: vi.fn().mockResolvedValue([]),
            setMilestones: vi.fn().mockResolvedValue(undefined),
            filterMilestonesInProject: vi.fn().mockResolvedValue([]),
            findByIds: vi.fn().mockResolvedValue([]),
            nextKeyNumber: vi.fn().mockResolvedValue(1),
            lockRankScope: vi.fn().mockResolvedValue(undefined),
            findMaxRank: vi.fn().mockResolvedValue(null),
            create: vi.fn(),
            update: vi.fn(),
            setArchived: vi.fn(),
            countActiveChildFeatures: vi.fn().mockResolvedValue(0),
            countActiveChildWorkItems: vi.fn().mockResolvedValue(0),
          },
        },
        {
          provide: AccessService,
          // Default: unrestricted, so tests that are not about authorization stay short.
          useValue: {
            listReadableProjectIds: vi.fn().mockResolvedValue(null),
            assertProjectPermission: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ActivityLogger,
          // The Revision History feed is asserted in the activity module's own specs; here
          // it only has to exist, and `logSafe` must be a no-op that cannot fail a write.
          useValue: {
            build: vi.fn().mockReturnValue({}),
            buildDiff: vi.fn().mockReturnValue([]),
            logSafe: vi.fn().mockResolvedValue(undefined),
            listFor: vi.fn().mockResolvedValue({ data: [], total: 0 }),
          },
        },
        {
          provide: PreliminaryEstimateMapService,
          // The map's own fallback behaviour is covered by
          // `preliminary-estimate-map.service.spec.ts`; here it is a fixed input so these
          // tests are about how the SERVICE uses it.
          useValue: { forProject: vi.fn().mockResolvedValue(DEFAULT_PRELIMINARY_ESTIMATE_MAP) },
        },
        {
          provide: UnitOfWork,
          // Runs the callback with a stub executor: these tests assert the SERVICE's
          // ordering and validation, and the repository is mocked, so a real transaction
          // would add nothing. The advisory-lock/rank behaviour is proven in e2e against
          // a real database, where it can actually be observed.
          useValue: { run: (fn: (tx: unknown) => unknown) => fn({}) },
        },
        {
          provide: ProjectsService,
          // `assertProjectWritable` is the ONE home of PRJ-FR-010 and this module calls it.
          // Resolves by default; the block that is about it rejects deliberately.
          useValue: {
            assertProjectWritable: vi
              .fn()
              .mockResolvedValue({ id: 'proj-a', workspaceId: WORKSPACE, status: 'active' }),
          },
        },
        {
          provide: DRIZZLE,
          // ONE chain now: the Release/Team existence check in `assertReferences`
          // (`select→from→where→limit`). The destination-team lookup and the capacity-allocation
          // guard that also ran through here were `applyProjectMove`'s, and that method is gone with
          // the project move (`P5-PI-003`) — an `innerJoin` branch and a whole `selectDistinct` entry
          // point went with them rather than being left as scaffolding for a call nobody makes.
          useValue: {
            select: () => ({
              from: () => ({
                where: () => ({ limit: () => Promise.resolve(referenceRows) }),
              }),
            }),
          },
        },
      ],
    }).compile();

    service = module.get(PortfolioItemsService);
    repo = module.get(PORTFOLIO_ITEM_REPOSITORY);
    access = module.get(AccessService);
    maps = module.get(PreliminaryEstimateMapService);
    activity = module.get(ActivityLogger);
    projects = module.get(ProjectsService);
  });

  describe('listItems — the authorization filter', () => {
    it('passes null through as unrestricted for a workspace-wide grant', async () => {
      await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null });
      expect(repo.listByFilter).toHaveBeenCalledWith(
        WORKSPACE,
        expect.objectContaining({ readableProjectIds: null }),
        expect.anything(),
      );
    });

    it('passes the readable project ids down to the repository', async () => {
      access.listReadableProjectIds.mockResolvedValue(['proj-a', 'proj-b']);
      await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null });
      expect(repo.listByFilter).toHaveBeenCalledWith(
        WORKSPACE,
        expect.objectContaining({ readableProjectIds: ['proj-a', 'proj-b'] }),
        expect.anything(),
      );
    });

    it('FAILS CLOSED with an empty page when no project is readable', async () => {
      // The case that must never reach SQL as "no filter". Returning everything here
      // would leak every project to a user with no project access at all.
      access.listReadableProjectIds.mockResolvedValue([]);

      const page = await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null });

      expect(page.data).toEqual([]);
      expect(repo.listByFilter).not.toHaveBeenCalled();
      // Reports a real zero rather than omitting the count: the grid footer always shows
      // "of N" on this endpoint, and a missing total renders differently from 0.
      expect(page.pageInfo.total).toBe(0);
    });

    it('rejects an explicit projectId the caller cannot read', async () => {
      access.listReadableProjectIds.mockResolvedValue(['proj-a']);
      await expect(
        service.listItems(
          actor,
          { type: 'feature', projectId: 'proj-secret' },
          { limit: 50, cursor: null },
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
      expect(repo.listByFilter).not.toHaveBeenCalled();
    });

    it('allows an explicit projectId the caller can read', async () => {
      access.listReadableProjectIds.mockResolvedValue(['proj-a']);
      await service.listItems(
        actor,
        { type: 'feature', projectId: 'proj-a' },
        { limit: 50, cursor: null },
      );
      expect(repo.listByFilter).toHaveBeenCalled();
    });

    it('does not gate an explicit projectId when the grant is workspace-wide', async () => {
      // readable === null means every project, so any projectId is permitted.
      await service.listItems(
        actor,
        { type: 'feature', projectId: 'proj-anything' },
        { limit: 50, cursor: null },
      );
      expect(repo.listByFilter).toHaveBeenCalled();
    });

    it('returns an explicit empty page for Epic + a specific Team, without querying', async () => {
      // An Epic has no Team, so the combination can never match. The spec shows a
      // "Filter not show item" message rather than an empty grid, so the API must return
      // empty instead of silently ignoring the team filter and listing every Epic.
      const page = await service.listItems(
        actor,
        { type: 'epic', teamId: 'team-1' },
        { limit: 50, cursor: null },
      );
      expect(page.data).toEqual([]);
      expect(repo.listByFilter).not.toHaveBeenCalled();
      expect(access.listReadableProjectIds).not.toHaveBeenCalled();
      expect(page.pageInfo.total).toBe(0);
    });
  });

  describe('progress', () => {
    it('computes the four indicators from the rollup', async () => {
      repo.listByFilter.mockResolvedValue(emptyPage([view()]));

      const page = await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null });
      const p = page.data[0].progress;

      expect(p.percentDoneByPlanEstimate).toBe(0.25); // 10 / 40
      expect(p.percentDoneByCount).toBe(0.5); // 1 / 2
      // Preliminary 'm' → 5 points / 3 count from the seeded default map.
      expect(p.estimatedProgressByPoints).toBe(2); // 10 / 5
      expect(p.estimatedProgressByCount).toBeCloseTo(1 / 3);
    });

    it('prefers a refined estimate over the preliminary mapping', async () => {
      repo.listByFilter.mockResolvedValue(
        emptyPage([view({ refinedEstimate: '20', refinedItemCountEstimate: 4 })]),
      );
      const p = (await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null }))
        .data[0].progress;
      expect(p.estimatedProgressByPoints).toBe(0.5); // 10 / 20
      expect(p.estimatedProgressByCount).toBe(0.25); // 1 / 4
    });

    it('uses whatever mapping the project reader returns', async () => {
      // The whole reason the map is settings-backed: an operator changing XS/S/M must
      // change what Estimated Progress means, without a deploy. Per-project (SRS §6.2),
      // resolved from the item's own projectId.
      maps.forProject.mockResolvedValue({
        ...DEFAULT_PRELIMINARY_ESTIMATE_MAP,
        m: { points: 100, count: 50 },
      });
      repo.listByFilter.mockResolvedValue(emptyPage([view()]));

      const p = (await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null }))
        .data[0].progress;
      expect(p.estimatedProgressByPoints).toBe(0.1); // 10 / 100
    });
  });

  /**
   * Rally's status colour for a portfolio item: "Both of the Percent Done fields are
   * colored based on the status of the work needed to complete the portfolio item"
   * (Broadcom TechDocs, "Using the Portfolio Items Page").
   *
   * The arithmetic itself belongs to `computeHealth` and is pinned by
   * `libs/shared-kernel/src/health.spec.ts`. What these tests pin is the WIRING — that
   * the service feeds it the ACCEPTED rollup and the PLANNED dates, since feeding it the
   * completed rollup would silently colour un-signed-off work as delivered.
   */
  describe('health', () => {
    /** `today` is real, so fixtures are expressed as offsets from now. */
    const dayOffset = (days: number): string => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    async function healthOf(over: Parameters<typeof view>[0]) {
      repo.listByFilter.mockResolvedValue(emptyPage([view(over)]));
      const page = await service.listItems(actor, { type: 'feature' }, { limit: 50, cursor: null });
      return page.data[0].health;
    }

    it('has no verdict without planned dates, and says WHY', async () => {
      // The default fixture has neither date. Green here would assert an on-time
      // schedule that nobody has entered.
      const health = await healthOf({});
      expect(health.state).toBe('not_started');
      expect(health.indeterminate).toBe('no_dates');
    });

    it('is on track when acceptance keeps pace with the planned window', async () => {
      // Half the window gone, half the points accepted.
      const health = await healthOf({
        plannedStartDate: dayOffset(-50),
        plannedEndDate: dayOffset(50),
        rollup: { ...view().rollup, acceptedPoints: 20, rollupPoints: 40 },
      });
      expect(health.state).toBe('on_track');
      expect(health.percentDone).toBe(0.5);
    });

    it('is LATE when acceptance falls far behind the required rate', async () => {
      // 90% of the window gone, 10% accepted — more than 40% behind.
      const health = await healthOf({
        plannedStartDate: dayOffset(-90),
        plannedEndDate: dayOffset(10),
        rollup: { ...view().rollup, acceptedPoints: 4, rollupPoints: 40 },
      });
      expect(health.state).toBe('late');
    });

    it('measures ACCEPTED work, not completed work', async () => {
      // The D1 distinction. Everything is finished but nothing is signed off, so the
      // item is behind — reading `completedPoints` here would report it as done.
      const health = await healthOf({
        plannedStartDate: dayOffset(-90),
        plannedEndDate: dayOffset(10),
        rollup: {
          ...view().rollup,
          acceptedPoints: 0,
          completedPoints: 40,
          rollupPoints: 40,
        },
      });
      expect(health.state).toBe('late');
      expect(health.percentDone).toBe(0);
    });

    it('is COMPLETE only once the planned end has passed as well', async () => {
      const base = { rollup: { ...view().rollup, acceptedPoints: 40, rollupPoints: 40 } };

      // Rally's blue: "the current date is after the Planned End Date AND the artifacts
      // are 100% done".
      expect(
        (
          await healthOf({
            ...base,
            plannedStartDate: dayOffset(-90),
            plannedEndDate: dayOffset(-10),
          })
        ).state,
      ).toBe('complete');

      // Finished EARLY is still green — ahead of a schedule that has not ended.
      expect(
        (
          await healthOf({
            ...base,
            plannedStartDate: dayOffset(-50),
            plannedEndDate: dayOffset(50),
          })
        ).state,
      ).toBe('on_track');
    });

    it('is exposed on the single-item read too, so the detail page agrees with the grid', async () => {
      repo.findViewById.mockResolvedValue(
        view({ plannedStartDate: dayOffset(-50), plannedEndDate: dayOffset(50) }),
      );
      const item = await service.getItem(actor, 'pi-1');
      expect(item.health.state).toBeDefined();
      expect(item.health.indeterminate).toBeNull();
    });
  });

  describe('single-item reads', () => {
    it('throws NotFound for an unknown id', async () => {
      repo.findViewById.mockResolvedValue(null);
      await expect(service.getItem(actor, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('checks existence before listing children, so a bad id is not an empty list', async () => {
      // An empty list would read as "this Feature has no children" rather than "no such
      // Feature", which is the difference between a data question and a bug report.
      repo.findById.mockResolvedValue(null);
      await expect(
        service.listChildren(actor, 'missing', { limit: 50, cursor: null }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.listChildren).not.toHaveBeenCalled();
    });

    it('checks existence before listing child features', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.listChildFeatures(actor, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.listChildFeatures).not.toHaveBeenCalled();
    });

    /**
     * The Feature picker feed. What is worth asserting is the ABSENCE of a check: the route carries
     * `@RequirePermission('work_item:view', { from: 'query', field: 'projectId' })`, so the guard has
     * already decided this exact project. A `listReadableProjectIds` narrowing here would answer a
     * different question — which projects are readable — and silently widen a route the guard had
     * already scoped, while an `assertProjectPermission` would be the double-check the guard's own
     * docblock warns against. A future reader adding either would fail this test, which is the point.
     */
    it('passes the project straight through, with no second authorization call', async () => {
      repo.listFeatureOptions.mockResolvedValue([
        { id: 'fe-1', itemKey: 'FE-1', name: 'A feature', projectId: 'proj-a' },
      ]);

      const options = await service.listFeatureOptions(actor, 'proj-a');

      expect(options).toHaveLength(1);
      expect(repo.listFeatureOptions).toHaveBeenCalledWith(WORKSPACE, 'proj-a');
      expect(access.listReadableProjectIds).not.toHaveBeenCalled();
      expect(access.assertProjectPermission).not.toHaveBeenCalled();
    });
  });

  describe('createItem', () => {
    const newFeature = { projectId: 'proj-a', type: 'feature' as const, name: 'A feature' };

    beforeEach(() => {
      repo.create.mockImplementation((input) => Promise.resolve(input as never));
      repo.findViewById.mockResolvedValue(view());
    });

    it('checks project permission BEFORE touching the database', async () => {
      access.assertProjectPermission.mockRejectedValue(new Error('denied'));
      await expect(service.createItem(actor, newFeature)).rejects.toThrow('denied');
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.lockRankScope).not.toHaveBeenCalled();
    });

    it('mints the key from the (workspace, type) sequence with the type prefix', async () => {
      repo.nextKeyNumber.mockResolvedValue(318);
      await service.createItem(actor, newFeature);
      expect(repo.nextKeyNumber).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE, type: 'feature' },
        expect.anything(),
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'FE-318' }),
        expect.anything(),
      );
    });

    it('uses the EP- prefix for an Epic', async () => {
      repo.nextKeyNumber.mockResolvedValue(7);
      await service.createItem(actor, { projectId: 'proj-a', type: 'epic', name: 'An epic' });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'EP-7' }),
        expect.anything(),
      );
    });

    it('LOCKS the rank scope before reading the max rank', async () => {
      // The whole point of the lock. If the read happens first, two concurrent creates
      // derive the SAME rank and the next drag-reorder throws on equal neighbours —
      // exactly the corruption work items already suffered in 22 scopes.
      await service.createItem(actor, newFeature);
      expect(repo.lockRankScope.mock.invocationCallOrder[0]).toBeLessThan(
        repo.findMaxRank.mock.invocationCallOrder[0],
      );
    });

    it('appends after the current max rank, never a degenerate empty rank', async () => {
      repo.findMaxRank.mockResolvedValue('m');
      await service.createItem(actor, newFeature);
      const rank = repo.create.mock.calls[0][0].rank;
      expect(rank > 'm').toBe(true);
      expect(rank).not.toBe('');
    });

    it('retries once with a fresh key when the unique index rejects the first', async () => {
      // MAX+1 is not atomic, so a concurrent create can take the same number.
      repo.create.mockRejectedValueOnce(new Error('duplicate key uq_portfolio_item_key'));
      repo.nextKeyNumber.mockResolvedValueOnce(4).mockResolvedValueOnce(5);

      await service.createItem(actor, newFeature);

      expect(repo.create).toHaveBeenCalledTimes(2);
      expect(repo.create.mock.calls[1][0].itemKey).toBe('FE-5');
    });

    it('gives up after the retry rather than looping', async () => {
      repo.create.mockRejectedValue(new Error('still colliding'));
      await expect(service.createItem(actor, newFeature)).rejects.toThrow('still colliding');
      expect(repo.create).toHaveBeenCalledTimes(2);
    });

    it('refuses an Epic that carries Feature-only fields', async () => {
      // `ck_portfolio_epic_shape` would also catch this, but as a 500 with a Postgres
      // message. The named error tells the caller which field is the problem.
      await expect(
        service.createItem(actor, {
          projectId: 'proj-a',
          type: 'epic',
          name: 'An epic',
          teamId: 'team-1',
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_TYPE' });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses a parent that is not an Epic', async () => {
      repo.findByIds.mockResolvedValue([
        { id: 'pi-2', type: 'feature', archivedAt: null } as never,
      ]);
      await expect(
        service.createItem(actor, { ...newFeature, parentId: 'pi-2' }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_PARENT' });
    });

    it('refuses an archived parent Epic', async () => {
      repo.findByIds.mockResolvedValue([
        { id: 'pi-2', type: 'epic', archivedAt: new Date() } as never,
      ]);
      await expect(
        service.createItem(actor, { ...newFeature, parentId: 'pi-2' }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_PARENT' });
    });

    it('refuses a parent id that does not resolve at all', async () => {
      // No FK on parent_id, so an unchecked bogus uuid would persist and then render as
      // an empty Epic column — indistinguishable from "not set".
      repo.findByIds.mockResolvedValue([]);
      await expect(
        service.createItem(actor, { ...newFeature, parentId: 'nope' }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_PARENT' });
    });
  });

  describe('updateItem', () => {
    beforeEach(() => {
      repo.findViewById.mockResolvedValue(view());
      repo.update.mockResolvedValue(view());
    });

    // SRS §5.1 scopes the Milestone selector to the item's own Project. These two pin that
    // the scope check runs BEFORE the write, so a cross-project id cannot land and then be
    // "cleaned up" later.
    it('refuses a Milestone that does not belong to the item\u2019s project', async () => {
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        type: 'feature',
        projectId: 'proj-a',
      } as never);
      repo.filterMilestonesInProject.mockResolvedValue(['ms-1']); // only one of the two is in-project
      await expect(
        service.updateItem(actor, 'pi-1', { milestoneIds: ['ms-1', 'ms-2'] }),
      ).rejects.toMatchObject({ code: 'MILESTONE_PROJECT_MISMATCH' });
      expect(repo.setMilestones).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('writes Milestones through setMilestones, not as a column patch', async () => {
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        type: 'feature',
        projectId: 'proj-a',
      } as never);
      repo.filterMilestonesInProject.mockResolvedValue(['ms-1', 'ms-2']);
      await service.updateItem(actor, 'pi-1', { milestoneIds: ['ms-1', 'ms-2'], name: 'Renamed' });
      expect(repo.setMilestones).toHaveBeenCalledWith('pi-1', ['ms-1', 'ms-2']);
      // The link ids must NOT reach the column update — there is no such column.
      expect(repo.update).toHaveBeenCalledWith(
        'pi-1',
        expect.not.objectContaining({ milestoneIds: expect.anything() }),
        WORKSPACE,
      );
    });

    it('validates the shape against the STORED type, so an Epic cannot gain a Team', async () => {
      // `type` is not updatable, so the only way an Epic could acquire Feature fields is
      // if the check used the request body's type instead of the row's.
      repo.findById.mockResolvedValue({ id: 'pi-1', type: 'epic', projectId: 'proj-a' } as never);
      await expect(service.updateItem(actor, 'pi-1', { teamId: 'team-1' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_INVALID_TYPE',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses to make an item its own Epic', async () => {
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        type: 'feature',
        projectId: 'proj-a',
      } as never);
      await expect(service.updateItem(actor, 'pi-1', { parentId: 'pi-1' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_INVALID_PARENT',
      });
    });

    it('passes null through as "clear" and omits absent fields entirely', async () => {
      // The repository distinguishes the two; this proves the service does not normalise
      // one into the other on the way down.
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        type: 'feature',
        projectId: 'proj-a',
      } as never);
      await service.updateItem(actor, 'pi-1', { releaseId: null });
      const patch = repo.update.mock.calls[0][1];
      expect(patch).toHaveProperty('releaseId', null);
      expect(patch).not.toHaveProperty('name');
    });

    it('404s for an unknown id before checking permission', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.updateItem(actor, 'missing', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('records the update in Revision History, diffed against the STORED row', async () => {
      // Diffing against `existing` rather than the response is what makes the entry say
      // what actually changed; diffing against the fresh read would show nothing.
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        workspaceId: 'ws-1',
        projectId: 'proj-a',
        type: 'feature',
        state: 'intake',
      } as never);
      await service.updateItem(actor, 'pi-1', { state: 'developing' });
      const [subject, , before, patch] = activity.buildDiff.mock.calls[0];
      expect(subject).toMatchObject({ entityType: 'portfolio_item', entityId: 'pi-1' });
      expect(before).toMatchObject({ state: 'intake' });
      expect(patch).toMatchObject({ state: 'developing' });
    });

    it('never lets a history write fail the update', async () => {
      // `logSafe`, not `log`: the feed is secondary to the mutation that produced it.
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        workspaceId: 'ws-1',
        projectId: 'proj-a',
        type: 'feature',
      } as never);
      await service.updateItem(actor, 'pi-1', { name: 'Renamed' });
      expect(activity.logSafe).toHaveBeenCalled();
      // The mock deliberately does not define `log`, proving the service never reaches for it.
      expect((activity as unknown as Record<string, unknown>).log).toBeUndefined();
    });
    /**
     * A Project is chosen ONCE, at creation (`P5-PI-003`, BA DEV Handoff retest 2026-08-17).
     *
     * INVERTED. This block used to assert the MOVE and everything it reconciled — a Team reset to the
     * destination's first linked team, a cleared Release, a cleared cross-project Epic, surviving
     * Milestones, and permission on both projects. `WID-FR-017` and the report's rule 4 say the move
     * "is not supported", §3.1 says "Project is read-only for both types", and AC5 forbids changing it
     * from detail or inline edit. Real Rally DOES offer the move, so this is a declared divergence —
     * see the note on `UpdatePortfolioItemSchema` for the Broadcom wording that argued the other way.
     *
     * `PORTFOLIO_ITEM_HAS_CAPACITY_ALLOCATION` did NOT go with it: that rule also guards the
     * allocate side, and its own tests live with the capacity module.
     */
    describe('a Project cannot be changed after creation (P5-PI-003)', () => {
      const feature = {
        id: 'pi-1',
        type: 'feature',
        projectId: 'proj-a',
        teamId: 'team-a',
        releaseId: 'rel-a',
        parentId: null,
      };

      it('REFUSES a different project', async () => {
        repo.findById.mockResolvedValue(feature as never);

        await expect(
          service.updateItem(actor, 'pi-1', { projectId: 'proj-b' }),
        ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_PROJECT_IMMUTABLE' });
        expect(repo.update).not.toHaveBeenCalled();
      });

      it('refuses BEFORE writing anything else in the same patch', async () => {
        // A move bundled with a legitimate rename must not half-apply.
        repo.findById.mockResolvedValue(feature as never);

        await expect(
          service.updateItem(actor, 'pi-1', { projectId: 'proj-b', name: 'Renamed' }),
        ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_PROJECT_IMMUTABLE' });
        expect(repo.update).not.toHaveBeenCalled();
      });

      it('accepts the SAME project as a no-op, and never writes the column', async () => {
        // A client echoing the whole record back is not refused for agreeing, and `project_id` is
        // stripped so the update cannot rewrite it even to its current value.
        repo.findById.mockResolvedValue(feature as never);

        await service.updateItem(actor, 'pi-1', { projectId: 'proj-a', name: 'Renamed' });

        const patch = repo.update.mock.calls[0][1];
        expect(patch).not.toHaveProperty('projectId');
        expect(patch).toHaveProperty('name', 'Renamed');
        // Nothing is reconciled, because nothing moved.
        expect(patch).not.toHaveProperty('teamId');
        expect(patch).not.toHaveProperty('releaseId');
      });

      it('checks references against the item’s OWN project', async () => {
        repo.findById.mockResolvedValue(feature as never);

        await service.updateItem(actor, 'pi-1', { name: 'Renamed' });

        // There is no destination to distinguish any more, so a second project can never appear in
        // this write — which is what made the old reconciliation necessary.
        expect(access.assertProjectPermission).toHaveBeenCalledWith(
          actor,
          'proj-a',
          'portfolio:edit',
        );
        expect(access.assertProjectPermission).not.toHaveBeenCalledWith(
          actor,
          'proj-b',
          'portfolio:edit',
        );
      });
    });
  });

  describe('setArchived', () => {
    beforeEach(() => {
      repo.findViewById.mockResolvedValue(view());
      repo.setArchived.mockResolvedValue(view());
    });

    it('refuses to archive an Epic that still has active child Features', async () => {
      // Archiving it would leave those Features pointing at a parent the user can no
      // longer open, while the Epic's rollup kept aggregating through them.
      repo.findById.mockResolvedValue({ id: 'ep-1', type: 'epic', projectId: 'proj-a' } as never);
      repo.countActiveChildFeatures.mockResolvedValue(2);

      await expect(service.setArchived(actor, 'ep-1', true)).rejects.toMatchObject({
        code: 'PORTFOLIO_EPIC_HAS_ACTIVE_FEATURES',
      });
      expect(repo.setArchived).not.toHaveBeenCalled();
    });

    it('archives an Epic once its Features are gone', async () => {
      repo.findById.mockResolvedValue({ id: 'ep-1', type: 'epic', projectId: 'proj-a' } as never);
      repo.countActiveChildFeatures.mockResolvedValue(0);
      await service.setArchived(actor, 'ep-1', true);
      expect(repo.setArchived).toHaveBeenCalledWith('ep-1', true, WORKSPACE);
    });

    /**
     * INVERTED by `P5-PI-011` (DEV Handoff 2026-08-14). This case used to assert that a Feature took no
     * child guard, on the reading that "a Feature's children are Stories/Defects, which keep working
     * when it is archived". The BA calls that a Fail: "DevInt allowed FE-5 to be archived even though
     * child Work Item US-8 was linked… Archive must enforce the approved child guard."
     *
     * The orphaning is the same shape as the Epic case one level up — the children stay in the Backlog
     * carrying a Feature column that opens nothing, and they keep feeding the archived Feature's rollup.
     */
    it('REFUSES to archive a Feature that still has child work items', async () => {
      repo.findById.mockResolvedValue({
        id: 'fe-1',
        type: 'feature',
        projectId: 'proj-a',
      } as never);
      repo.countActiveChildWorkItems.mockResolvedValue(1);

      await expect(service.setArchived(actor, 'fe-1', true)).rejects.toMatchObject({
        code: 'PORTFOLIO_FEATURE_HAS_ACTIVE_WORK_ITEMS',
      });
      expect(repo.setArchived).not.toHaveBeenCalled();
    });

    it('archives a Feature once its work items are gone', async () => {
      repo.findById.mockResolvedValue({
        id: 'fe-1',
        type: 'feature',
        projectId: 'proj-a',
      } as never);
      repo.countActiveChildWorkItems.mockResolvedValue(0);

      await service.setArchived(actor, 'fe-1', true);
      expect(repo.setArchived).toHaveBeenCalledWith('fe-1', true, WORKSPACE);
    });

    it('does not apply the WORK-ITEM guard when restoring a Feature', async () => {
      // Restoring cannot create the orphaned state; the other direction is guarded by
      // `PORTFOLIO_PARENT_ARCHIVED` (its Epic must not be archived).
      repo.findById.mockResolvedValue({
        id: 'fe-1',
        type: 'feature',
        projectId: 'proj-a',
        parentId: null,
      } as never);
      await service.setArchived(actor, 'fe-1', false);
      expect(repo.countActiveChildWorkItems).not.toHaveBeenCalled();
      expect(repo.setArchived).toHaveBeenCalledWith('fe-1', false, WORKSPACE);
    });

    it('never applies the guard when RESTORING, even for an Epic', async () => {
      repo.findById.mockResolvedValue({ id: 'ep-1', type: 'epic', projectId: 'proj-a' } as never);
      repo.countActiveChildFeatures.mockResolvedValue(5);
      await service.setArchived(actor, 'ep-1', false);
      expect(repo.setArchived).toHaveBeenCalledWith('ep-1', false, WORKSPACE);
    });
  });

  describe('an ARCHIVED item is read-only', () => {
    /**
     * SRS §5.5 archives instead of deleting, and every rollup, plan total and cutline already excludes
     * archived work. The only `archivedAt` checks on the write path looked at the PARENT, so an archived
     * Feature could still be renamed, re-stated, re-ranked and re-pointed at a Release while
     * contributing nothing to any number on screen.
     */
    beforeEach(() => {
      repo.findViewById.mockResolvedValue(view());
    });

    it('refuses an edit', async () => {
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        itemKey: 'FE-1',
        type: 'feature',
        projectId: 'proj-a',
        archivedAt: new Date(),
      } as never);

      await expect(service.updateItem(actor, 'pi-1', { name: 'Renamed' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_ARCHIVED',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses a rank move', async () => {
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        itemKey: 'FE-1',
        type: 'feature',
        projectId: 'proj-a',
        rank: 'm',
        archivedAt: new Date(),
      } as never);

      await expect(service.rankItem(actor, 'pi-1', { afterId: 'pi-2' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_ARCHIVED',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('still allows RESTORE, which is the only write on an archived row', async () => {
      // `setArchived` deliberately skips the guard: unarchiving is by definition a write on an
      // archived item, and refusing it would make the state permanent.
      repo.findById.mockResolvedValue({
        id: 'pi-1',
        itemKey: 'FE-1',
        type: 'feature',
        projectId: 'proj-a',
        parentId: null,
        archivedAt: new Date(),
      } as never);
      repo.setArchived.mockResolvedValue(view());

      await expect(service.setArchived(actor, 'pi-1', false)).resolves.toBeTruthy();
      expect(repo.setArchived).toHaveBeenCalledWith('pi-1', false, 'ws-1');
    });
  });

  describe('the resolved top-down estimate travels on the item', () => {
    /**
     * Computed here for the progress bars and then discarded, so every client re-derived it — and the
     * Epic Children tab did not, rendering `refinedEstimate` raw. That column is NOT NULL DEFAULT 0
     * where 0 means "not forecast", so a Feature sized by a T-shirt only reported 0 in the column and
     * in its totals row.
     */
    it('prefers the refined forecast', async () => {
      repo.findViewById.mockResolvedValue(
        view({ refinedEstimate: '30', refinedItemCountEstimate: 4 }),
      );

      const item = await service.getItem(actor, 'pi-1');

      expect(item.estimate.points).toEqual({ value: 30, tier: 'refined' });
      expect(item.estimate.count).toEqual({ value: 4, tier: 'refined' });
    });

    it('falls through a ZERO refined forecast to the Preliminary mapping', async () => {
      // 'm' is 5 points / 3 items in the seeded default map.
      repo.findViewById.mockResolvedValue(
        view({ refinedEstimate: '0', refinedItemCountEstimate: 0, preliminaryEstimate: 'm' }),
      );

      const item = await service.getItem(actor, 'pi-1');

      expect(item.estimate.points).toEqual({ value: 5, tier: 'preliminary' });
      expect(item.estimate.count).toEqual({ value: 3, tier: 'preliminary' });
    });

    it('reports `none` for an item nobody has sized, rather than a confident zero', async () => {
      repo.findViewById.mockResolvedValue(
        view({
          refinedEstimate: '0',
          refinedItemCountEstimate: 0,
          preliminaryEstimate: 'no_entry',
        }),
      );

      const item = await service.getItem(actor, 'pi-1');

      expect(item.estimate.points).toEqual({ value: 0, tier: 'none' });
    });
  });

  describe('rankItem', () => {
    const feature = (over = {}) =>
      ({ id: 'pi-1', type: 'feature', projectId: 'proj-a', rank: 'm', ...over }) as never;

    beforeEach(() => {
      repo.findById.mockResolvedValue(feature());
      repo.findViewById.mockResolvedValue(view());
      repo.update.mockResolvedValue(view());
    });

    it('derives a rank strictly between the two neighbours', async () => {
      repo.findByIds.mockResolvedValue([
        feature({ id: 'a', rank: 'a' }),
        feature({ id: 'c', rank: 'c' }),
      ]);

      await service.rankItem(actor, 'pi-1', { beforeId: 'a', afterId: 'c' });

      const rank = repo.update.mock.calls[0][1].rank as string;
      expect(rank > 'a').toBe(true);
      expect(rank < 'c').toBe(true);
    });

    it('treats a null neighbour as the list edge', async () => {
      repo.findByIds.mockResolvedValue([feature({ id: 'c', rank: 'c' })]);
      await service.rankItem(actor, 'pi-1', { beforeId: null, afterId: 'c' });
      expect((repo.update.mock.calls[0][1].rank as string) < 'c').toBe(true);
    });

    it('refuses a body with NEITHER neighbour', async () => {
      // `between(null, null)` returns a mid-range rank unrelated to the list, which would
      // silently teleport the row somewhere the user never dropped it.
      await expect(service.rankItem(actor, 'pi-1', {})).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_RANK_CONFLICT',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses to use itself as a neighbour', async () => {
      await expect(service.rankItem(actor, 'pi-1', { beforeId: 'pi-1' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_RANK_CONFLICT',
      });
    });

    it('refuses a neighbour of the OTHER type — a different rank scope', async () => {
      // Epics and Features are ranked independently. Mixing them would interleave two
      // orderings and make the next drag throw on incomparable neighbours.
      repo.findByIds.mockResolvedValue([feature({ id: 'ep', type: 'epic', rank: 'b' })]);
      await expect(service.rankItem(actor, 'pi-1', { beforeId: 'ep' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_RANK_CONFLICT',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses a neighbour that no longer exists', async () => {
      repo.findByIds.mockResolvedValue([]);
      await expect(service.rankItem(actor, 'pi-1', { beforeId: 'gone' })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_RANK_CONFLICT',
      });
    });

    it('refuses neighbours supplied OUT OF ORDER instead of corrupting the order', async () => {
      // A stale client view: `before` ranks above `after`. `between()` throws and we turn
      // that into a refusal rather than writing a rank neither neighbour implies.
      repo.findByIds.mockResolvedValue([
        feature({ id: 'hi', rank: 'z' }),
        feature({ id: 'lo', rank: 'a' }),
      ]);
      await expect(
        service.rankItem(actor, 'pi-1', { beforeId: 'hi', afterId: 'lo' }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_RANK_CONFLICT' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("checks permission on the item's own project", async () => {
      access.assertProjectPermission.mockRejectedValue(new Error('denied'));
      await expect(service.rankItem(actor, 'pi-1', { beforeId: 'a' })).rejects.toThrow('denied');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('404s for an unknown item', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.rankItem(actor, 'missing', { beforeId: 'a' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /**
   * PRJ-03. "Archived Projects are read-only regardless of access level" (PRJ-FR-010).
   *
   * This module had `assertNotArchived`, which asks whether the ITEM is archived — a different
   * question with a different answer, and having it there is most likely why the project-level rule
   * was never noticed missing. An active Feature in an archived project passed every check.
   *
   * Both directions of `setArchived` are guarded, including RESTORE, and that is safe rather than a
   * trap: restoring an item does not undo the project's archive, so nothing becomes unreachable —
   * `PATCH /projects/:id` with `status: 'active'` is the one write an archived project accepts and
   * it takes no preconditions.
   */
  describe('an archived project refuses every portfolio write (PRJ-FR-010)', () => {
    beforeEach(() => {
      repo.findById.mockResolvedValue(view());
      repo.findViewById.mockResolvedValue(view());
      projects.assertProjectWritable.mockRejectedValue(
        new PreconditionFailedException('PROJECT_ARCHIVED', 'archived'),
      );
    });

    it('refuses a new Epic or Feature', async () => {
      await expect(
        service.createItem(actor, { projectId: 'proj-a', type: 'feature', name: 'A feature' }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses an edit', async () => {
      await expect(service.updateItem(actor, 'pi-1', { name: 'Renamed' })).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses a move INTO an archived project, not just out of one', async () => {
      // The destination is checked as well as the source. Without it, an archived project could be
      // filled with work from the outside — the read-only rule broken on the one write that touches
      // two projects. Both calls reject here, so the assertion is that the write never happened.
      await expect(
        service.updateItem(actor, 'pi-1', { projectId: 'proj-b' }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses archiving an item', async () => {
      await expect(service.setArchived(actor, 'pi-1', true)).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(repo.setArchived).not.toHaveBeenCalled();
    });

    it('refuses RESTORING an item — restore the PROJECT first, which always works', async () => {
      await expect(service.setArchived(actor, 'pi-1', false)).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(repo.setArchived).not.toHaveBeenCalled();
    });

    it('refuses a rank change', async () => {
      await expect(service.rankItem(actor, 'pi-1', { beforeId: 'a' })).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses the attachment resolve step — archived takes no new files', async () => {
      // `getItemForWrite` is what `PortfolioAttachmentsController` calls on presign/confirm and
      // delete, so the rule reaches those routes without `EntityAttachmentsService` learning about
      // projects.
      await expect(service.getItemForWrite(actor, 'pi-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
    });

    it('still READS the item — archived is read-only, not invisible', async () => {
      await expect(service.getItem(actor, 'pi-1')).resolves.toMatchObject({ id: 'pi-1' });
    });
  });
});

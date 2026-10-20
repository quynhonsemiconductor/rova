import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  UnitOfWork,
  between,
} from '@platform';
import { AccessService } from '@modules/access';
import { ActivityLogger, type ActivityLog } from '@modules/activity';
import { ProjectsService } from '@modules/projects';
import { PORTFOLIO_ACTIVITY_CONFIG } from './portfolio-activity-diff';
import { PORTFOLIO_HEALTH_THRESHOLDS, computeHealth, type HealthResult } from '@shared-kernel';
import type { CursorPayload, JwtPayload, PagedResult } from '@platform';
import { releases, teams } from '../../../../../db/schema/work';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB } from '@platform';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_PRELIMINARY_ESTIMATE_MAP,
  type PreliminaryEstimateMap,
} from '../../../../../db/schema/enums';
import {
  computePortfolioProgress,
  defaultAllocationEstimate,
  type PortfolioProgress,
  type ResolvedEstimate,
} from '../domain/portfolio-rollup';
import { PreliminaryEstimateMapService } from './preliminary-estimate-map.service';
import {
  PORTFOLIO_ITEM_REPOSITORY,
  type IPortfolioItemRepository,
  type PortfolioChildItem,
} from '../domain/ports/portfolio-item.repository';
import type {
  CreatePortfolioItemInput,
  PortfolioFeatureOption,
  PortfolioItem,
  PortfolioItemView,
  PortfolioListRequest,
  PortfolioRankScope,
  UpdatePortfolioItemInput,
} from '../domain/portfolio-item.types';
import type { PortfolioItemType } from '../../../../../db/schema/enums';

/** `EP-` / `FE-` — the display-key prefix per portfolio type. */
const KEY_PREFIX: Record<PortfolioItemType, string> = { epic: 'EP', feature: 'FE' };

/** A portfolio item with its four computed progress indicators and its health verdict. */
export interface PortfolioItemWithProgress extends PortfolioItemView {
  progress: PortfolioProgress;
  /**
   * Rally's green/yellow/red/blue status for a portfolio item, computed against the
   * planned window (Broadcom TechDocs, "Using the Portfolio Items Page"): at risk when the
   * acceptance rate is >20% below the rate needed to finish by the Planned End Date, late
   * at >40%, blue once the end date has passed AND everything is done.
   *
   * Deliberately NOT applied to Releases/Iterations/Milestones: Rally documents this scheme
   * for portfolio items only, and shows a percent-complete state bar on those surfaces
   * instead — which this app already renders.
   */
  health: HealthResult;
  /**
   * The resolved top-down estimate per unit, with the tier that produced it.
   *
   * `Refined > 0`, else the Preliminary size mapping, else 0 with tier `none` — the same chain the
   * progress bars above are divided by, and the same one a capacity plan copies from when a planner
   * leaves Estimate blank. Shipped because every client otherwise re-derives it, and one of them
   * (the Epic Children tab) instead rendered the raw `refinedEstimate`, showing 0 for work sized by
   * a T-shirt only.
   */
  estimate: {
    points: ResolvedEstimate;
    count: ResolvedEstimate;
  };
}

/** One child type's share of the accepted-children rollup. */
export interface AcceptedChildrenGroup {
  type: 'story' | 'defect';
  points: number;
  count: number;
  acceptedPoints: number;
  acceptedCount: number;
}

/**
 * The "Total Accepted Children" panel on the detail page: accepted vs linked, in points or
 * item count, with a row per child type.
 *
 * `total` comes from the item's own rollup rather than from summing `byType`, so the panel
 * and the Percent Done indicators on the same page can never disagree — they are then
 * literally the same numbers. `byType` only splits that total up.
 *
 * A type with no children is still returned with zeroes: Rally shows "Defects: 0% 0/0"
 * rather than hiding the row, and a missing row would read as "this Feature cannot have
 * defects" instead of "it has none".
 */
export interface AcceptedChildrenRollup {
  total: { points: number; count: number; acceptedPoints: number; acceptedCount: number };
  byType: AcceptedChildrenGroup[];
}

/** The detail surface: the grid row plus the accepted-children breakdown and Milestones. */
export interface PortfolioItemDetail extends PortfolioItemWithProgress {
  acceptedChildren: AcceptedChildrenRollup;
  /** Assigned Milestones, name-ordered. The rail renders these as a multi-select. */
  milestones: { id: string; name: string }[];
}

/**
 * An empty page for the cases this service refuses to send to SQL.
 *
 * Carries `total: 0` because the list endpoint otherwise always reports a count, and a
 * footer that reads "0 of —" for a denied caller but "0 of 0" for a genuinely empty
 * project would look like two different bugs.
 */
function emptyPage(limit: number): PagedResult<PortfolioItemWithProgress> {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false, limit, total: 0 } };
}

@Injectable()
export class PortfolioItemsService {
  constructor(
    @Inject(PORTFOLIO_ITEM_REPOSITORY) private readonly repo: IPortfolioItemRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly access: AccessService,
    private readonly uow: UnitOfWork,
    private readonly estimateMaps: PreliminaryEstimateMapService,
    private readonly activity: ActivityLogger,
    /**
     * Owns `assertProjectWritable`, the one home of "Archived Projects are read-only regardless
     * of access level" (PRJ-FR-010). Note this is a DIFFERENT rule from `assertNotArchived` at
     * the bottom of this file, which asks whether the ITEM is archived — the two can disagree,
     * and both are checked on the writes that have both subjects.
     */
    private readonly projects: ProjectsService,
  ) {}

  /**
   * The activity subject for one item. `entity_type: 'portfolio_item'` was added to the
   * shared enum by 0081; `activity_logs` needed nothing else, being polymorphic already.
   */
  private subject(item: Pick<PortfolioItem, 'id' | 'workspaceId' | 'projectId'>) {
    return {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      entityType: 'portfolio_item' as const,
      entityId: item.id,
    };
  }

  /** Revision History for one item, paged. Mirrors the milestone/release endpoints. */
  async getActivity(
    actor: JwtPayload,
    id: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    // Existence + permission first, so a bad id is a 404 rather than an empty feed.
    await this.requireItem(actor, id);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activity.listFor(id, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  async listItems(
    actor: JwtPayload,
    filter: PortfolioListRequest,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<PortfolioItemWithProgress>> {
    // An Epic has no Team, so a team filter can only ever match Features. The spec
    // shows an explicit "Filter not show item" message for Epic + specific Team rather
    // than an empty grid, so return empty here and let the UI say why.
    if (filter.teamId && filter.type === 'epic') {
      return emptyPage(args.limit);
    }

    // The authorization boundary for this cross-project list.
    //
    // The ROUTE only proves the caller may read the workspace — `portfolio:view` is
    // project-tier and this route's projectId is optional, so the guard cannot check it.
    // Without the filter below a Project Member would list every project's portfolio,
    // which contradicts BA spec §3.2 and Rally, where access follows project permission.
    //
    // `null` means unrestricted (workspace-wide grant). An empty array means "no
    // readable projects" and must return nothing rather than everything — the two are
    // deliberately distinguishable so this cannot fail open.
    const readable = await this.access.listReadableProjectIds(
      actor.workspaceId,
      actor.sub,
      'portfolio:view',
    );

    if (readable !== null) {
      if (readable.length === 0) {
        return emptyPage(args.limit);
      }
      // An explicit projectId must be one the caller can read; narrowing to the
      // intersection means a request for someone else's project returns empty rather
      // than leaking whether it exists.
      if (filter.projectId && !readable.includes(filter.projectId)) {
        // Same code `AccessService.assertProjectPermission` throws, so a client can
        // branch on one value regardless of which layer denied it. Arg order is
        // (code, message) — the single-arg form is the legacy message-only shape.
        throw new PermissionDeniedException(
          'PROJECT_PERMISSION_DENIED',
          'You do not have permission to perform this action on this project',
        );
      }
    }

    const page = await this.repo.listByFilter(
      actor.workspaceId,
      { ...filter, readableProjectIds: readable },
      args,
    );
    // Per-PROJECT maps (SRS §6.2): a cross-project page can mix projects whose XS…XL
    // scales differ, so one workspace-level map would size an item from project A by
    // project B's points. Resolve each distinct project's map once, then look up per row.
    const byProject = new Map(
      await Promise.all(
        [...new Set(page.data.map((i) => i.projectId))].map(
          async (id): Promise<[string, PreliminaryEstimateMap]> => [
            id,
            await this.estimateMaps.forProject(id),
          ],
        ),
      ),
    );
    // One clock for the whole page: two rows with identical dates and identical rollups
    // must never disagree because the loop crossed midnight between them.
    const today = new Date();

    return {
      data: page.data.map((item) => {
        const map = byProject.get(item.projectId) ?? DEFAULT_PRELIMINARY_ESTIMATE_MAP;
        return this.withProgress(item, map, today);
      }),
      pageInfo: page.pageInfo,
    };
  }

  async getItem(actor: JwtPayload, id: string): Promise<PortfolioItemDetail> {
    const item = await this.repo.findViewById(id, actor.workspaceId);
    if (!item) {
      throw new NotFoundException('PORTFOLIO_ITEM_NOT_FOUND', 'Portfolio item not found');
    }
    const map = await this.estimateMaps.forProject(item.projectId);
    const [groups, milestones] = await Promise.all([
      this.repo.childRollupByType(id, actor.workspaceId),
      this.repo.listMilestones(id, actor.workspaceId),
    ]);
    return {
      ...this.withProgress(item, map),
      milestones,
      acceptedChildren: {
        total: {
          points: item.rollup.rollupPoints,
          count: item.rollup.rollupCount,
          acceptedPoints: item.rollup.acceptedPoints,
          acceptedCount: item.rollup.acceptedCount,
        },
        // Both types always present, zero-filled — see AcceptedChildrenRollup.
        byType: (['story', 'defect'] as const).map(
          (type) =>
            groups.find((g) => g.type === type) ?? {
              type,
              points: 0,
              count: 0,
              acceptedPoints: 0,
              acceptedCount: 0,
            },
        ),
      },
    };
  }

  /**
   * `getItem`, plus the archived-project refusal — the resolve step a WRITE on an item opens with.
   *
   * It exists for `PortfolioAttachmentsController`, whose routes live there rather than in
   * `@modules/attachments` precisely so that authorization stays with the owning context. That
   * controller resolves the item to prove it exists and to get the `projectId` the activity log
   * needs; attaching or deleting a file is content on that project, so the same resolve has to
   * carry the read-only rule (PRJ-FR-010). Putting it here rather than in the controller keeps the
   * rule in a service, and keeps `EntityAttachmentsService` free of any project knowledge — it
   * states that it "never loads a work item or a portfolio item", and giving it `ProjectsService`
   * would be the owner-type registry its own docblock refuses.
   */
  async getItemForWrite(actor: JwtPayload, id: string): Promise<PortfolioItemDetail> {
    const item = await this.getItem(actor, id);
    await this.projects.assertProjectWritable(actor.workspaceId, item.projectId);
    return item;
  }

  async listChildren(
    actor: JwtPayload,
    id: string,
    args: { limit: number; cursor: CursorPayload | null; search?: string },
  ): Promise<PagedResult<PortfolioChildItem>> {
    // Existence check first, so a bad id is a 404 rather than an empty list that looks
    // like "this Feature has no children".
    const item = await this.repo.findById(id, actor.workspaceId);
    if (!item) {
      throw new NotFoundException('PORTFOLIO_ITEM_NOT_FOUND', 'Portfolio item not found');
    }
    return this.repo.listChildren(id, actor.workspaceId, args);
  }

  async listChildFeatures(actor: JwtPayload, id: string): Promise<PortfolioItemWithProgress[]> {
    const item = await this.repo.findById(id, actor.workspaceId);
    if (!item) {
      throw new NotFoundException('PORTFOLIO_ITEM_NOT_FOUND', 'Portfolio item not found');
    }
    const map = await this.estimateMaps.forProject(item.projectId);
    const children = await this.repo.listChildFeatures(id, actor.workspaceId);
    const today = new Date();
    return children.map((c) => this.withProgress(c, map, today));
  }

  /**
   * A project's active Features, as options for the `Feature` field on a Story/Defect.
   *
   * NO authorization call here, and that is deliberate rather than an omission: the route
   * carries `@RequirePermission('work_item:view', { from: 'query', field: 'projectId' })`, so the
   * guard has already checked this exact project before the handler runs. Re-checking would be
   * the double-check the guard's own docblock warns against — and adding a
   * `listReadableProjectIds` narrowing here would be worse, because it would answer a different
   * question (which projects are readable) than the one the route asks (may you read THIS one).
   *
   * Contrast `listItems` directly above: that list's `projectId` is optional because a Workspace
   * Admin reads across projects, which is why its authorization has to live in the service.
   */
  async listFeatureOptions(
    actor: JwtPayload,
    projectId: string,
  ): Promise<PortfolioFeatureOption[]> {
    return this.repo.listFeatureOptions(actor.workspaceId, projectId);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Create an Epic or a Feature.
   *
   * Authorization is per-PROJECT here, unlike the cross-project list: a write targets
   * exactly one project, so `assertProjectPermission` can and must check it.
   */
  async createItem(
    actor: JwtPayload,
    input: Omit<CreatePortfolioItemInput, 'workspaceId'>,
  ): Promise<PortfolioItemWithProgress> {
    await this.access.assertProjectPermission(actor, input.projectId, 'portfolio:create');
    // PRJ-FR-010: an archived project takes no new content. One home for the rule —
    // `ProjectsService.assertProjectWritable` — so this cannot answer differently from the
    // work-item, iteration, release and milestone creates.
    await this.projects.assertProjectWritable(actor.workspaceId, input.projectId);
    this.assertShape(input.type, input);
    await this.assertReferences(actor.workspaceId, input.projectId, input);

    const scope: PortfolioRankScope = { workspaceId: actor.workspaceId, type: input.type };

    // The key is MAX+1, which is not atomic, so a concurrent create can take the same
    // number and lose the `uq_portfolio_item_key` race. Retry once with a fresh key —
    // the same shape releases use. A failed insert only leaves a numbering gap.
    const MAX_KEY_RETRIES = 2;
    let created: PortfolioItem | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      try {
        created = await this.uow.run(async (tx) => {
          // Rank is derived INSIDE the transaction under a per-scope advisory lock, and
          // both the read and the insert use `tx`. Computing it outside is a lock-free
          // read-modify-write: two creates read the same max, derive the SAME rank, and
          // the next drag-reorder throws on the equal neighbours. That is exactly how
          // work items ended up with 22 scopes sharing a rank.
          await this.repo.lockRankScope(scope, tx);
          const maxRank = await this.repo.findMaxRank(scope, tx);
          const keyNumber = await this.repo.nextKeyNumber(scope, tx);

          return this.repo.create(
            {
              ...input,
              workspaceId: actor.workspaceId,
              id: uuidv7(),
              itemKey: `${KEY_PREFIX[input.type]}-${keyNumber}`,
              // New items append to the end of their scope. A degenerate '' rank sorts
              // correctly once but corrupts later `between()` math.
              rank: between(maxRank, null),
            },
            tx,
          );
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!created) throw lastErr;
    // `logSafe`: a history entry must never fail the write that produced it.
    await this.activity.logSafe([
      this.activity.build(this.subject(created), actor.sub, 'portfolio_item.created', null),
    ]);
    return this.getItem(actor, created.id);
  }

  async updateItem(
    actor: JwtPayload,
    id: string,
    input: UpdatePortfolioItemInput,
  ): Promise<PortfolioItemWithProgress> {
    const existing = await this.requireItem(actor, id);
    await this.access.assertProjectPermission(actor, existing.projectId, 'portfolio:edit');
    await this.projects.assertProjectWritable(actor.workspaceId, existing.projectId);
    assertNotArchived(existing);

    /**
     * A record's Project is chosen ONCE, at creation (`P5-PI-003`, retest 2026-08-17).
     *
     * A REFUSAL and not a silent discard, following `TASK_ITERATION_DERIVED`: the contract already
     * dropped the field (`UpdatePortfolioItemSchema`), so nothing over HTTP can reach this — it
     * guards the internal callers the type still permits, and says why rather than ignoring them.
     * Same value is a no-op, so a client echoing the whole record back is not refused for agreeing.
     */
    const patch = { ...input };
    if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
      throw new PreconditionFailedException(
        'PORTFOLIO_ITEM_PROJECT_IMMUTABLE',
        'A Project is set when the item is created and cannot be changed afterwards',
      );
    }
    delete patch.projectId;

    // Validated against the EXISTING type: `type` is immutable, so an Epic can never
    // acquire a parent/team/release by editing.
    this.assertShape(existing.type, patch);
    // References are checked against the item's OWN project, which is now the only project this
    // write can land in — a move is refused above, so there is no destination to distinguish.
    await this.assertReferences(actor.workspaceId, existing.projectId, patch, id);

    // Milestones live in their own link table, so they are NOT a column patch — pull them
    // out before `repo.update` sees them, and write them separately.
    //
    // Scoped to the item's own project, like every other reference on this write: SRS §5.1
    // limits the selector to "the Feature's Project plus any already-selected Milestones", so
    // a milestone from another project must be refused rather than silently dropped.
    const { milestoneIds, ...columns } = patch;
    if (milestoneIds !== undefined) {
      const inProject = await this.repo.filterMilestonesInProject(
        milestoneIds,
        existing.projectId,
        actor.workspaceId,
      );
      if (inProject.length !== milestoneIds.length) {
        throw new PreconditionFailedException(
          'MILESTONE_PROJECT_MISMATCH',
          'Every Milestone must belong to this item\u2019s Project',
        );
      }
    }

    await this.repo.update(id, columns, actor.workspaceId);
    if (milestoneIds !== undefined) await this.repo.setMilestones(id, milestoneIds);
    await this.activity.logSafe(
      this.activity.buildDiff(
        this.subject(existing),
        actor.sub,
        existing as unknown as Record<string, unknown>,
        patch,
        PORTFOLIO_ACTIVITY_CONFIG,
        'portfolio_item.updated',
      ),
    );
    return this.getItem(actor, id);
  }

  /**
   * Archive (soft delete) or restore.
   *
   * An Epic with ACTIVE child Features is refused. Archiving it would leave those
   * Features pointing at a hidden parent: they would still appear in the Feature list
   * with an Epic column referencing something the user can no longer open, and the
   * Epic's rollup would keep aggregating through them.
   */
  async setArchived(
    actor: JwtPayload,
    id: string,
    archived: boolean,
  ): Promise<PortfolioItemWithProgress> {
    const existing = await this.requireItem(actor, id);
    await this.access.assertProjectPermission(actor, existing.projectId, 'portfolio:archive');
    /**
     * Guarded in BOTH directions, including restore.
     *
     * Restoring an ITEM does not undo the PROJECT's archive, so guarding it strands nothing: the
     * project is reopened by `PATCH /projects/:id` with `status: 'active'`, which takes no
     * preconditions and is the only write an archived project accepts. Nothing requires an item to
     * be restored first. Archiving is content too — it removes the row from every portfolio
     * surface and from its Epic's rollup — so neither direction is exempt (PRJ-FR-010).
     */
    await this.projects.assertProjectWritable(actor.workspaceId, existing.projectId);

    if (archived && existing.type === 'epic') {
      const children = await this.repo.countActiveChildFeatures(id, actor.workspaceId);
      if (children > 0) {
        throw new PreconditionFailedException(
          'PORTFOLIO_EPIC_HAS_ACTIVE_FEATURES',
          `Archive or move the ${children} active Feature(s) under this Epic first`,
        );
      }
    }

    /**
     * A FEATURE with active child work items is refused too — the same rule one level down.
     *
     * `P5-PI-011` (DEV Handoff 2026-08-14): "DevInt allowed FE-5 to be archived even though child Work
     * Item US-8 was linked… Archive must enforce the approved child guard". Only the Epic half existed,
     * so a Feature could be hidden under its own children: they stay in the Backlog with a Feature
     * column pointing at something the reader cannot open, and they keep feeding that Feature's rollup —
     * word for word the state this method's docblock says it exists to prevent.
     *
     * The link is `work_items.feature_id`, not `parent_id`. Only ARCHIVING is guarded; restoring a
     * Feature is already guarded in the other direction (its Epic must not be archived), and a restore
     * cannot create this state.
     */
    if (archived && existing.type === 'feature') {
      const children = await this.repo.countActiveChildWorkItems(id, actor.workspaceId);
      if (children > 0) {
        throw new PreconditionFailedException(
          'PORTFOLIO_FEATURE_HAS_ACTIVE_WORK_ITEMS',
          `Move or delete the ${children} work item(s) under this Feature first`,
        );
      }
    }

    /**
     * RESTORING a Feature whose Epic is archived is refused too.
     *
     * The archive guard above only looked one way, so the forbidden state was reachable in three
     * legal steps: archive the Feature, archive the now-childless Epic, then restore the Feature —
     * leaving an ACTIVE Feature under a hidden parent, which is exactly what this method's own
     * docstring says it exists to prevent, and what `assertReferences` refuses on any other write
     * ("Cannot attach a Feature to an archived Epic").
     *
     * Restore the Epic first. Naming it in the message matters: an archived parent is invisible in
     * every list, so "restore the Epic" is unactionable without knowing which one.
     */
    if (!archived && existing.type === 'feature' && existing.parentId !== null) {
      const [parent] = await this.repo.findByIds([existing.parentId], actor.workspaceId);
      if (parent && parent.archivedAt !== null) {
        throw new PreconditionFailedException(
          'PORTFOLIO_PARENT_ARCHIVED',
          `Its Epic ${parent.itemKey} is archived — restore that first`,
        );
      }
    }

    await this.repo.setArchived(id, archived, actor.workspaceId);
    return this.getItem(actor, id);
  }

  /**
   * Move one item between two neighbours by deriving a LexoRank strictly between their
   * ranks — a single-row UPDATE, never a renumbering pass.
   *
   * `beforeId`/`afterId` are the rows immediately ABOVE and BELOW the drop position in
   * ascending rank order; either is null at a list edge. Both null would mean "between
   * nothing and nothing", which `between()` answers with a mid-range rank that has no
   * relation to the list — so the caller must name at least one neighbour.
   *
   * Every neighbour must share this item's RANK SCOPE, which for portfolio items is
   * (workspace, type) rather than (project, parent): the list is cross-project and flat
   * per type. Accepting an Epic as a Feature's neighbour would interleave two independent
   * orderings and make the next drag throw.
   *
   * Deliberately does NOT take the advisory lock that `createItem` uses. This is a
   * read-modify-write too, but the value written is derived from two SPECIFIC neighbours
   * the client already sees, not from a shared MAX — so two concurrent drags can only
   * collide by targeting the identical gap, and the loser lands on an equal rank rather
   * than corrupting the scope. `between()` rejects the stale-neighbour case below, which
   * is the failure that actually matters.
   */
  async rankItem(
    actor: JwtPayload,
    id: string,
    opts: { beforeId?: string | null; afterId?: string | null },
  ): Promise<PortfolioItemWithProgress> {
    const item = await this.requireItem(actor, id);
    await this.access.assertProjectPermission(actor, item.projectId, 'portfolio:edit');
    await this.projects.assertProjectWritable(actor.workspaceId, item.projectId);
    assertNotArchived(item);

    if (!opts.beforeId && !opts.afterId) {
      throw new PreconditionFailedException(
        'PORTFOLIO_ITEM_RANK_CONFLICT',
        'A move needs at least one neighbour',
      );
    }

    const neighbourIds = [opts.beforeId, opts.afterId].filter(
      (n): n is string => typeof n === 'string',
    );
    if (neighbourIds.includes(id)) {
      throw new PreconditionFailedException(
        'PORTFOLIO_ITEM_RANK_CONFLICT',
        'An item cannot be its own neighbour',
      );
    }

    const neighbours = await this.repo.findByIds(neighbourIds, actor.workspaceId);
    const byId = new Map(neighbours.map((n) => [n.id, n]));

    const rankOf = (nid: string | null | undefined): string | null => {
      if (!nid) return null;
      const n = byId.get(nid);
      // Same type = same rank scope. A missing row is the same class of problem as a
      // wrong-scope one: the client is working from an order that no longer exists.
      if (!n || n.type !== item.type) {
        throw new PreconditionFailedException(
          'PORTFOLIO_ITEM_RANK_CONFLICT',
          'Neighbour is not in the same portfolio order; refresh and retry',
        );
      }
      return n.rank;
    };

    const lowRank = rankOf(opts.beforeId);
    const highRank = rankOf(opts.afterId);

    let rank: string;
    try {
      rank = between(lowRank, highRank);
    } catch {
      // Neighbours out of order — the client's view is stale. Refuse rather than write a
      // rank that would sort the row somewhere neither neighbour implies.
      throw new PreconditionFailedException(
        'PORTFOLIO_ITEM_RANK_CONFLICT',
        'Portfolio order changed; refresh and retry',
      );
    }

    await this.repo.update(id, { rank }, actor.workspaceId);
    return this.getItem(actor, id);
  }

  private async requireItem(actor: JwtPayload, id: string): Promise<PortfolioItem> {
    const item = await this.repo.findById(id, actor.workspaceId);
    if (!item) {
      throw new NotFoundException('PORTFOLIO_ITEM_NOT_FOUND', 'Portfolio item not found');
    }
    return item;
  }

  /**
   * Reject Epic-illegal fields with a clear error before the DB CHECK does.
   *
   * `ck_portfolio_epic_shape` already guarantees this, but a raw constraint violation
   * surfaces as a 500 with a Postgres message. Callers get a 422 naming the field.
   */
  private assertShape(
    type: PortfolioItemType,
    input: Pick<UpdatePortfolioItemInput, 'parentId' | 'teamId' | 'releaseId'>,
  ): void {
    if (type !== 'epic') return;
    const offending = (['parentId', 'teamId', 'releaseId'] as const).filter(
      (f) => input[f] !== undefined && input[f] !== null,
    );
    if (offending.length > 0) {
      throw new PreconditionFailedException(
        'PORTFOLIO_ITEM_INVALID_TYPE',
        `An Epic cannot have ${offending.join(', ')} — those belong to a Feature`,
      );
    }
  }

  /**
   * Verify every id the caller supplied actually resolves.
   *
   * None of `parent_id`, `team_id` or `release_id` carries a database foreign key, so an
   * unchecked bogus uuid would persist happily and then render as an empty Epic/Team/
   * Release column — indistinguishable from "not set", and impossible to explain later.
   */
  private async assertReferences(
    workspaceId: string,
    projectId: string,
    input: Pick<UpdatePortfolioItemInput, 'parentId' | 'teamId' | 'releaseId'>,
    selfId?: string,
  ): Promise<void> {
    if (input.parentId) {
      if (selfId && input.parentId === selfId) {
        // `ck_portfolio_no_self_parent` also covers this; named error beats a 500.
        throw new PreconditionFailedException(
          'PORTFOLIO_ITEM_INVALID_PARENT',
          'An item cannot be its own Epic',
        );
      }
      const [parent] = await this.repo.findByIds([input.parentId], workspaceId);
      if (!parent) {
        // 422 rather than 404: the missing thing is a field the caller sent, not the
        // resource they addressed, so the failure belongs to the request body.
        throw new PreconditionFailedException(
          'PORTFOLIO_ITEM_INVALID_PARENT',
          'Parent Epic not found',
        );
      }
      if (parent.type !== 'epic') {
        throw new PreconditionFailedException(
          'PORTFOLIO_ITEM_INVALID_PARENT',
          'A Feature’s parent must be an Epic',
        );
      }
      if (parent.archivedAt !== null) {
        throw new PreconditionFailedException(
          'PORTFOLIO_ITEM_INVALID_PARENT',
          'Cannot attach a Feature to an archived Epic',
        );
      }
    }

    if (input.releaseId) {
      // Releases are per-project (`uq_releases_key` is on project), so a release from
      // another project would put the Release column out of step with the row's project.
      const rows = await this.db
        .select({ id: releases.id })
        .from(releases)
        .where(
          and(
            eq(releases.id, input.releaseId),
            eq(releases.workspaceId, workspaceId),
            eq(releases.projectId, projectId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new PreconditionFailedException(
          'PORTFOLIO_ITEM_PROJECT_MISMATCH',
          'Release not found in this project',
        );
      }
    }

    if (input.teamId) {
      const rows = await this.db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, workspaceId)))
        .limit(1);
      if (rows.length === 0) {
        throw new PreconditionFailedException('PORTFOLIO_ITEM_TEAM_MISMATCH', 'Team not found');
      }
    }
  }

  /**
   * Turn one item's rollup into the four indicators.
   *
   * The Preliminary Estimate fallback comes from WORKSPACE SETTINGS, never a code
   * constant: the BA spec calls the seeded values temporary and defers the real scale
   * to Settings > Workspace > Project Management, and Rally makes the equivalent
   * mapping a workspace-admin setting.
   */
  private withProgress(
    item: PortfolioItemView,
    map: PreliminaryEstimateMap,
    /**
     * Injected so the verdict is deterministic per request rather than shifting between
     * rows of the same page, and so tests can pin a date instead of mocking the clock.
     */
    today: Date = new Date(),
  ): PortfolioItemWithProgress {
    const size = map[item.preliminaryEstimate] ?? { points: 0, count: 0 };
    return {
      ...item,
      // Health measures ACCEPTED work against the planned window, so it uses the accepted
      // rollup — not the completed one. That is the same D1 distinction the two Percent
      // Done indicators rest on: signed-off, not merely finished.
      health: computeHealth({
        accepted: item.rollup.acceptedPoints,
        total: item.rollup.rollupPoints,
        start: item.plannedStartDate === null ? null : new Date(item.plannedStartDate),
        end: item.plannedEndDate === null ? null : new Date(item.plannedEndDate),
        today,
        thresholds: PORTFOLIO_HEALTH_THRESHOLDS,
      }),
      progress: computePortfolioProgress(item.rollup, {
        refinedPoints: Number(item.refinedEstimate),
        refinedCount: item.refinedItemCountEstimate,
        preliminaryPoints: size.points,
        preliminaryCount: size.count,
      }),
      /**
       * The RESOLVED top-down estimate, and which tier produced it.
       *
       * Already computed here for the progress bars and then thrown away, so every client had to
       * re-derive it — and the Epic Children tab did not, rendering `refinedEstimate` raw. That is 0
       * for a Feature sized only by a T-shirt, and the wire documents 0 as "not forecast", so the
       * column and its totals row read zero for work that has an estimate.
       *
       * Both units, because the portfolio shows both (`% Done by Est.` and `% Done by Count`) and a
       * capacity plan picks one per plan. `defaultAllocationEstimate` rather than `resolveEstimate`:
       * an item has no allocated tier of its own — that belongs to a plan. Precedent for shipping
       * value-plus-tier: `capacity-plan-response.dto.ts`.
       */
      estimate: {
        points: defaultAllocationEstimate({
          refined: Number(item.refinedEstimate),
          preliminary: size.points,
        }),
        count: defaultAllocationEstimate({
          refined: item.refinedItemCountEstimate,
          preliminary: size.count,
        }),
      },
    };
  }
}

/**
 * An ARCHIVED item is read-only. Restoring it is the way back.
 *
 * SRS §5.5 archives instead of deleting, and §15 of the Capacity spec calls archived work "not
 * actionable planning demand" — every rollup, every plan total and the cutline already exclude it. It
 * was still fully editable: the only `archivedAt` checks anywhere on the write path looked at the
 * PARENT (an archived Epic cannot take a Feature, an archived Epic's Feature cannot be restored), so
 * an archived Feature could be renamed, re-stated, re-ranked and re-pointed at a Release while
 * contributing nothing to any number on the screen.
 *
 * Worse on the Children tab: `Add Item` there is create-then-link, and the link is refused by
 * `assertFeatureLinkable` (`WORK_ITEM_FEATURE_LINK_ARCHIVED`) — so the Story was created, the PATCH
 * failed, and a parentless Story was left in the backlog by an action that reported an error.
 *
 * `setArchived` deliberately does NOT call this: unarchiving is a write on an archived row, and it is
 * the only one that can be.
 */
function assertNotArchived(item: { itemKey: string; archivedAt: Date | null }): void {
  // `== null`, not `=== null`: the column is NOT NULL-or-a-date in production, but a partially-mocked
  // row in a unit test must read as active rather than as archived — a guard that fires on a missing
  // field would refuse every write for the wrong reason.
  if (item.archivedAt == null) return;
  throw new PreconditionFailedException(
    'PORTFOLIO_ITEM_ARCHIVED',
    `${item.itemKey} is archived — restore it before editing`,
  );
}

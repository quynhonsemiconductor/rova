import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  ConflictException,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  UnitOfWork,
  isDuplicateKeyError,
} from '@platform';
import type { DrizzleDB, JwtPayload } from '@platform';
import { AccessService } from '@modules/access';
import {
  PortfolioItemsService,
  PreliminaryEstimateMapService,
  computeCapacityWarnings,
  computeCutlineIndex,
  defaultAllocationEstimate,
  type CapacityWarning,
  type EstimateTier,
  resolveEstimate,
} from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { projectTeams, releases, teamMembers, teams } from '../../../../../db/schema/work';
import {
  FORECAST_HISTORY_DAYS,
  forecastCapacity,
  forecastSeed,
  type ForecastComplexity,
  type ForecastResult,
} from '../domain/capacity-forecast';
import {
  CAPACITY_PLAN_REPOSITORY,
  type ICapacityPlanRepository,
} from '../domain/ports/capacity-plan.repository';
import type {
  CapacityAllocationSource,
  PreliminaryEstimateSize,
} from '../../../../../db/schema/enums';
import type {
  CapacityAllocationView,
  CapacityMetrics,
  CreateCapacityAllocationInput,
  UpdateCapacityAllocationInput,
} from '../domain/capacity-allocation.types';
import type {
  CapacityPlan,
  CapacityPlanTeam,
  CapacityPlanTeamView,
  CapacityPlanView,
  CreateCapacityPlanInput,
  PlanWindow,
  UpdateCapacityPlanInput,
} from '../domain/capacity-plan.types';

/** A plan team with the four numbers and the advisory warnings derived from them. */
export interface CapacityPlanTeamWithMetrics extends CapacityPlanTeamView {
  metrics: CapacityMetrics;
}

/**
 * Everything one plan's detail surface renders.
 *
 * `unallocated` is reported separately and is deliberately NOT part of any team's demand:
 * an unallocated placeholder must not outrank a Refined or Preliminary forecast, which is
 * the same reason `totalAllocatedFor` counts team-assigned rows only.
 */
/** One Feature on the plan, aggregated over its allocations — the agile ALM tool's Items tab row. */
export interface CapacityPlanItem {
  portfolioItemId: string;
  itemKey: string;
  name: string;
  rank: string;
  /**
   * The Feature's OWN project. Kept on the wire though no column shows it: the eligibility rules are
   * expressed in it, and `Move To Another Plan` needs it to explain why a target is or is not offered.
   */
  projectId: string;
  projectName: string | null;
  /**
   * The team that OWNS the Feature — the BA's `Team` column, which replaced the agile ALM tool's `Project`.
   *
   * NOT `primaryTeamId`: that is who owns the Feature inside THIS plan. This is its ownership outside
   * the plan, and the two diverge the moment a planner assigns the work elsewhere — which is exactly
   * what the column is for. The BA: "the Feature's original/current Team, not the Plan assignment."
   */
  teamId: string | null;
  teamName: string | null;
  /**
   * The Feature's OWN release, which the plan's release need not match.
   *
   * On the wire because `Move To Another Plan` decides from it whether the move also has to write
   * the Feature's Release — the rule the allocation guard enforces, stated where the UI can read it.
   */
  releaseId: string | null;
  /** Committed demand summed over this Feature's allocations. */
  estimated: number;
  rollup: number;
  complete: number;
  /**
   * The Feature has been archived, so it charges 0 on every tab.
   *
   * On the wire because the client had no way to explain a Feature reading zero: an archived Feature's
   * row metrics are zeroed, and the team rows sum those rows, so a Feature present on the Features tab
   * with nothing behind it looks like a data fault rather than an archived item.
   */
  archived: boolean;
  tier: EstimateTier;
  /** Teams this Feature is allocated to; empty when it sits only in the Unallocated bucket. */
  teamIds: string[];
  /**
   * The team that OWNS this Feature in the plan — the agile ALM tool's Planned Team Assignment.
   *
   * Null when only unallocated rows exist, which is the agile ALM tool's unassigned state.
   */
  primaryTeamId: string | null;
  /**
   * The Feature-level warnings the BA specifies for this tab: `Rollup exceeds Estimated`, and
   * `Point Estimated missing` when no tier produced a number.
   *
   * Computed here rather than in the client: they are the same rules, from the same function, that the
   * team grid and each allocation row already use. The Features tab could not show them at all before
   * — it had no `warnings`, no `metrics` and no `estimateBreakdown` to reason from, which is why the
   * triangles the BA asks for were absent rather than merely mis-styled.
   */
  warnings: CapacityWarning[];
  /**
   * All three estimate candidates behind `estimated`, for the tier tooltip.
   *
   * `allocated` is the SUM over this Feature's team rows — the item-level equivalent of a single
   * allocation's explicit value — and null when no team carries an explicit slice.
   */
  estimateBreakdown: {
    allocated: number | null;
    refined: number | null;
    preliminary: number | null;
  };
  /** True when any of its allocations has no team — the agile ALM tool's unassigned warning. */
  unallocated: boolean;
}

export interface CapacityPlanDetail extends Omit<CapacityPlanView, 'teams'> {
  teams: CapacityPlanTeamWithMetrics[];
  items: CapacityPlanItem[];
  /**
   * Index of the last ITEM (in rank order) that FITS inside the plan's total capacity — the agile ALM tool's rule,
   * "items above the cutline fit within the defined plan capacity".
   *
   * `-1` when the first item already exceeds it; `null` when no team has entered a capacity, so there
   * is nothing to draw a line against. A declared divergence from SRS §189 — see `computeCutlineIndex`.
   */
  itemCutlineIndex: number | null;
  allocations: CapacityAllocationView[];
  unallocated: number;
  /**
   * The PLAN's own advisory warnings, from the same rule function every row uses.
   *
   * The plan-level bars had none: `computeCapacityWarnings` was called for allocation rows, team rows
   * and Feature rows, and never over the totals, so a plan whose combined demand exceeded its combined
   * capacity read as clean while the rows beneath it flagged.
   */
  warnings: CapacityWarning[];
}

/**
 * Why a Feature did not take the full publish. Reported, never thrown.
 *
 * ONE entry per unique FEATURE, never per allocation row. A Feature split across two teams has two
 * allocation rows and one publish decision, so iterating the rows printed the same advisory twice —
 * `P5-CP-035`, and the reason `publishPlan` groups before it writes anything.
 */
export interface PublishSkip {
  portfolioItemId: string;
  itemKey: string;
  /**
   * `unallocated` — NO allocation of this Feature names a team, so there is no plan to inherit.
   * `no_window` — the PLAN states no planned start/end, so there is no window to stamp. Nothing is
   * written at all: with no window the span question is unanswerable too, so AC-019 already refuses
   * the Release field, which leaves this publish with no field it is allowed to touch. Reported per
   * Feature like `release_span_mismatch` (also a plan-level fact) because the rows are what the
   * planner is looking at — but the fix is on the PLAN, in `Edit Plan Details`.
   * `release_span_mismatch` — the plan's window does not EXACTLY match its release's, so the agile ALM tool writes
   * the dates but not the Release field. Not containment: a plan narrower than its release does not
   * reach outside it and still reports this, which is what AC-019 asks for.
   * `other_release` — the Feature is already committed to a DIFFERENT release. §226 lets the Team
   * picker pull such a Feature in, and publish must not be what moves it: dates written, Release
   * left alone, row reported.
   * `archived` — the Feature is archived, so the write matched no row. Reported rather than counted:
   * the plan still holds the allocation, and a planner who sees "3 Features updated" for two writes
   * has no way to find the third.
   */
  reason: 'unallocated' | 'no_window' | 'release_span_mismatch' | 'archived' | 'other_release';
}

export interface PublishResult {
  plan: CapacityPlanDetail;
  /** False for the agile ALM tool's "Publish Without Updating Fields". */
  fieldsUpdated: boolean;
  featuresUpdated: number;
  skipped: PublishSkip[];
}

/**
 * What the agile ALM tool's `Move To Another Plan` did.
 *
 * More than the source plan, because a move is not one write: rows can land on the target's teams,
 * rows whose team is not on the target have to be parked, the Feature's Release may have moved, and
 * a published target is unpublished by the move itself. A planner reading a single refreshed grid
 * would see none of that — the target is a different page.
 */
export interface MoveItemResult {
  /** The SOURCE plan, refreshed: the planner is still looking at it. */
  plan: CapacityPlanDetail;
  targetPlanId: string;
  targetPlanKey: string | null;
  /** Allocations recreated on the target against the same team. */
  carried: number;
  /**
   * Allocations whose team is not on the target plan, collapsed into ONE unassigned row there.
   *
   * The demand is kept rather than dropped: the Feature is still planned for that release, it just
   * has no team on this plan yet. Silently deleting it would make a move look like a removal.
   */
  parked: number;
  /** The agile ALM tool's `Update the Release to match the selected plan` actually wrote the Feature's Release. */
  releaseUpdated: boolean;
  /** The target was published and the move reverted it to draft, as the agile ALM tool does. */
  targetUnpublished: boolean;
  /** `Move and Republish the Plan` published it again afterwards. */
  targetRepublished: boolean;
}

export interface RevertResult {
  plan: CapacityPlanDetail;
  /**
   * Always false, and returned rather than implied: The agile ALM tool makes "no changes to the field
   * values in the portfolio items" on revert, so the Release and dates a publish wrote stay
   * put. "Revert" reads like an undo; this says plainly that it is not one.
   */
  fieldsRolledBack: false;
}

@Injectable()
export class CapacityPlansService {
  constructor(
    @Inject(CAPACITY_PLAN_REPOSITORY) private readonly repo: ICapacityPlanRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    // Publishing writes N Features and flips the plan's status; one transaction is what stops
    // a partial publish leaving Features carrying a plan that is still a draft.
    private readonly uow: UnitOfWork,
    private readonly access: AccessService,
    private readonly estimateMaps: PreliminaryEstimateMapService,
    private readonly portfolioItems: PortfolioItemsService,
    // Owns `assertProjectWritable` — the archived-project rule (PRJ-FR-010). See `requireDraft`.
    private readonly projects: ProjectsService,
  ) {}

  /**
   * Plans for one project.
   *
   * Authorization is straightforward here, unlike the Portfolio list: a plan belongs to
   * exactly one project and `projectId` is REQUIRED, so the route's guard already checked
   * the caller against it and there is no cross-project filtering to do.
   */
  async listPlans(actor: JwtPayload, projectId: string): Promise<CapacityPlanView[]> {
    const plans = await this.repo.listByProject(projectId, actor.workspaceId);
    if (await this.canSeeDrafts(actor, projectId)) return plans;
    // AC-013: "Draft plans do not appear in the Capacity Plan list" for a reader who cannot plan.
    return plans.filter((plan) => plan.status === 'published');
  }

  async getPlan(actor: JwtPayload, id: string): Promise<CapacityPlanView> {
    const plan = await this.repo.findViewById(id, actor.workspaceId);
    if (!plan) throw new NotFoundException('CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found');
    /**
     * A DRAFT is invisible to a non-planner, and `not found` is the honest answer.
     *
     * AC-013: a draft "does not appear in the list and cannot be opened". 403 would be the wrong
     * shape — it confirms the plan exists and even leaks its id as meaningful, which is exactly what
     * hiding it is meant to avoid. The BA's wording is about visibility, not about a refused action.
     *
     * Read paths only. Every write already calls `requireDraft`, which loads the plan itself and is
     * gated on `capacity:manage` — so a non-planner cannot reach one by writing either.
     */
    if (plan.status !== 'published' && !(await this.canSeeDrafts(actor, plan.projectId))) {
      throw new NotFoundException('CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found');
    }
    return plan;
  }

  /**
   * May this caller SEE draft plans?
   *
   * The BA's two acceptance criteria pull apart here, and our permission split has to express both:
   *
   *   • AC-012 — a Project Admin set to `Read-only` still opens "Draft and Published plans" while
   *     changing nothing;
   *   • AC-013 — a Project Member does not see Drafts at all.
   *
   * This used to be `capacity:manage || capacity:publish`, which satisfied AC-013 and broke AC-012:
   * a read-only Project Admin holds neither write code, so Drafts 404'd for them exactly as they do
   * for a Project Member. `capacity:view_draft` is the fourth code that separates the two, granted
   * to Project Admin and not to Project Member. The write grants still imply it — someone trusted to
   * edit or publish a plan is certainly meant to see it — so no role needs all three listed.
   */
  private async canSeeDrafts(actor: JwtPayload, projectId: string): Promise<boolean> {
    if (await this.access.hasProjectPermission(actor, projectId, 'capacity:view_draft'))
      return true;
    if (await this.access.hasProjectPermission(actor, projectId, 'capacity:manage')) return true;
    return this.access.hasProjectPermission(actor, projectId, 'capacity:publish');
  }

  async createPlan(
    actor: JwtPayload,
    // `planKey` is minted here, not accepted: a client-chosen key would collide with the
    // per-project counter and there is nothing a caller could sensibly pass.
    input: Omit<CreateCapacityPlanInput, 'workspaceId' | 'planKey'>,
  ): Promise<CapacityPlanView> {
    await this.access.assertProjectPermission(actor, input.projectId, 'capacity:manage');
    // Not routed through `requireDraft` — there is no plan yet — so the archived-project rule
    // is called here directly (PRJ-FR-010).
    await this.projects.assertProjectWritable(actor.workspaceId, input.projectId);
    await this.assertReleaseInProject(actor.workspaceId, input.projectId, input.releaseId);

    // Checked before inserting so the caller gets a named conflict rather than a raw
    // unique-violation 500. The index is still the real guarantee under a race.
    const existing = await this.repo.findByProjectRelease(
      input.projectId,
      input.releaseId,
      actor.workspaceId,
    );
    if (existing) {
      throw new ConflictException(
        'CAPACITY_PLAN_EXISTS',
        'This release already has a capacity plan',
      );
    }

    // `CP-<n>` from MAX+1, exactly as iterations mint `IT-<n>`: not atomic under concurrent
    // creates (two requests can read the same MAX before either commits), so retry once on the
    // unique violation `uq_capacity_plans_key` raises. One retry is enough — the second read
    // sees the first winner's committed row.
    const MAX_KEY_RETRIES = 2;
    let created: CapacityPlan | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      const keyNumber = await this.repo.nextKeyNumber(input.projectId, actor.workspaceId);
      try {
        created = await this.repo.create({
          ...input,
          workspaceId: actor.workspaceId,
          planKey: `CP-${keyNumber}`,
        });
        break;
      } catch (err: unknown) {
        lastErr = err;
        if (!isDuplicateKeyError(err) || attempt === MAX_KEY_RETRIES - 1) throw err;
      }
    }
    if (created === undefined) throw lastErr;

    return this.getPlan(actor, created.id);
  }

  /**
   * Hard delete — a PUBLISHED plan too, which is the one write on this service that a published
   * state does not block.
   *
   * The agile ALM tool is explicit: "you can delete an existing plan, even if the plan is published". It is the
   * same reasoning the agile ALM tool gives for unpublish not clearing field values — the plan is the planning
   * artefact, and the Release and planned dates it wrote onto Features are now those Features'
   * own data. Deleting the plan abandons the explanation, not the values, and a planner who wants
   * them undone reverts first (which is what revert is for).
   *
   * So this deliberately does NOT call `requireDraft`. It only checks the row exists in the
   * caller's workspace, which `findById` + the workspace-scoped delete both do.
   */
  async deletePlan(actor: JwtPayload, id: string): Promise<void> {
    const plan = await this.repo.findById(id, actor.workspaceId);
    if (!plan) {
      throw new NotFoundException('CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found');
    }
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');
    /**
     * Guarded, even though this is the one write a PUBLISHED state does not block.
     *
     * The two conditions are unrelated: `requireDraft` is skipped because the agile ALM tool lets a planner
     * delete a published plan, not because deleting is exempt from the project's read-only rule.
     * A plan is the project's planning artefact, so destroying it is a content change (PRJ-FR-010),
     * and nothing needs it deleted in order to restore the project — restoring is a
     * `PATCH /projects/:id` with `status: 'active'` and takes no preconditions.
     */
    await this.projects.assertProjectWritable(actor.workspaceId, plan.projectId);
    await this.repo.delete(id, actor.workspaceId);
  }

  async updatePlan(
    actor: JwtPayload,
    id: string,
    input: UpdateCapacityPlanInput,
  ): Promise<CapacityPlanView> {
    const plan = await this.requireDraft(actor, id);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');
    await this.repo.update(id, input, actor.workspaceId);
    return this.getPlan(actor, id);
  }

  // ── Teams ─────────────────────────────────────────────────────────────────

  async addTeam(actor: JwtPayload, id: string, teamId: string): Promise<CapacityPlanView> {
    const plan = await this.requireDraft(actor, id);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');
    await this.assertTeamInProject(actor.workspaceId, plan.projectId, teamId);

    // `uq_capacity_plan_team` would also catch this; the named error says which team.
    if (await this.repo.findTeam(id, teamId)) {
      throw new ConflictException(
        'CAPACITY_TEAM_ALREADY_ADDED',
        'That team is already on this plan',
      );
    }

    await this.repo.addTeam(id, teamId);
    return this.getPlan(actor, id);
  }

  /**
   * Set or clear a team's capacity.
   *
   * `null` CLEARS it back to "not entered", which is deliberately distinct from `0`:
   * a team with no capacity typed yet must not be reported as fully loaded, and the grid
   * renders blank rather than zero.
   */
  async setTeamCapacity(
    actor: JwtPayload,
    id: string,
    teamId: string,
    capacity: string | null,
  ): Promise<CapacityPlanView> {
    const plan = await this.requireDraft(actor, id);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');
    await this.requirePlanTeam(id, teamId);

    await this.repo.setTeamCapacity(id, teamId, capacity);
    return this.getPlan(actor, id);
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * Publish a plan: make it visible to everyone, and write the plan back onto its Features.
   *
   * The agile ALM tool: publishing "updates the Release, Planned Start Date, and Planned End Date for all
   * assigned and allocated portfolio items", and a planner may instead choose "Publish
   * Without Updating Fields" to publish while leaving those fields alone. Both are here as
   * `updateFields`.
   *
   * THE RISKY WRITE of Phase 5, and the reasons it is shaped this way:
   *
   *   • Only ASSIGNED allocations are written. An allocation parked in the Unallocated bucket
   *     names no team, so there is no plan for that Feature to inherit — writing the plan's
   *     window onto it would assert a schedule nobody agreed.
   *   • The Release field is written only when the plan's window MATCHES the release's, which
   *     is AC-019 stated three times in the BA's spec. A plan whose window differs at either end
   *     writes the DATES ONLY and reports why — the consequence still follows the agile ALM tool (a skip is
   *     reported, the rest of the publish stands), but the CONDITION is the BA's equality, not
   *     The agile ALM tool's containment. This was containment until it was ruled on: a two-week plan inside a
   *     quarter-long release wrote the Release field where the BA expects a reported skip.
   *   • Everything runs in ONE transaction with the status flip, so a partial publish cannot
   *     leave some Features carrying a plan that is still a draft.
   *   • Skips are REPORTED, never thrown. A planner needs to know which Features did not take
   *     the release and why; an exception would roll back a publish that is otherwise correct.
   */
  async publishPlan(
    actor: JwtPayload,
    id: string,
    options: { updateFields: boolean },
  ): Promise<PublishResult> {
    const plan = await this.requireDraft(actor, id);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:publish');

    const rows = await this.repo.listAllocations(plan);
    const teams = await this.repo.findViewById(id, actor.workspaceId);

    // The agile ALM tool blocks a publish only when ALL THREE hold: never published, no items, no
    // projects. A plan that has been published before may be re-published even when empty —
    // that is how a planner undoes an over-eager clear-out.
    const neverPublished = plan.publishedAt === null;
    if (neverPublished && rows.length === 0 && (teams?.teams.length ?? 0) === 0) {
      throw new PreconditionFailedException(
        'CAPACITY_PLAN_EMPTY',
        'Add a team and allocate at least one Feature before publishing',
      );
    }

    const skipped: PublishSkip[] = [];
    let featuresUpdated = 0;

    if (options.updateFields) {
      // Read once, outside the loop: every Feature takes the same window and the same release
      // decision. `window` is null when the plan states no window of its own, which is not a window
      // of nulls — see the `no_window` skip below.
      const releaseWindow = await this.repo.releaseWindow(plan.releaseId, actor.workspaceId);
      const window = planWindow(plan);
      const spansReleases = !windowsMatch(window, releaseWindow);
      // ONE entry per FEATURE, resolved BEFORE anything is written or reported. A publish is a
      // decision about a Feature — which window, which Release — and a split Feature's two allocation
      // rows carry the identical answer, so iterating rows wrote the same Feature twice and printed
      // its advisory twice (`P5-CP-035`). Order follows first appearance, which is the repository's
      // rank order with unallocated rows last.
      const features = publishTargets(rows);

      await this.uow.run(async (tx) => {
        for (const feature of features) {
          // NO allocation of this Feature names a team, so there is no plan for it to inherit.
          // Decided over the whole Feature, not per row: a Feature with one team row and one parked
          // row IS assigned, and used to be updated AND told it was unallocated.
          if (!feature.hasTeam) {
            skipped.push({
              portfolioItemId: feature.portfolioItemId,
              itemKey: feature.itemKey,
              reason: 'unallocated',
            });
            continue;
          }

          /**
           * A plan with NO window of its own writes NOTHING — it does not write emptiness.
           *
           * This was the shape of the bug: the window came straight off the plan's two nullable
           * columns, so publishing a plan that stated no window set `planned_start_date` and
           * `planned_end_date` to NULL on every assigned Feature — a plan write reaching outside the
           * plan to erase a value nobody asked it to clear. And it was the DEFAULT case, not an edge
           * one: SRS §5 gives the New Capacity Plan dialog six fields and no dates, so a plan has a
           * window only if a planner opened `Edit Plan Details` and set one.
           *
           * `continue` rather than a dateless write, because there is nothing left to write: with no
           * window `windowsMatch` cannot answer the span question either, so AC-019 has already
           * refused the Release field. Calling the repository here would bump `updated_at` on every
           * allocated Feature and count them as updated for no change at all — the same lie the
           * `archived` skip exists to avoid.
           */
          if (window === null) {
            skipped.push({
              portfolioItemId: feature.portfolioItemId,
              itemKey: feature.itemKey,
              reason: 'no_window',
            });
            continue;
          }

          /**
           * A Feature that already belongs to ANOTHER release keeps it.
           *
           * §226 lets the Team picker pull in a Feature on any release, so those rows now exist — and
           * publishing must not be how their Release silently changes. The dates are still written (the
           * plan does describe when this team will work on it); the Release is not, and the row is
           * reported, exactly as a window mismatch is.
           *
           * This is what the allocate-time guard was really protecting, and it belongs here: the rule
           * is about what publish WRITES, not about what a planner may staff.
           */
          const ownsOtherRelease =
            feature.releaseId !== null && feature.releaseId !== plan.releaseId;

          const written = await this.repo.applyPlanToFeature(
            feature.portfolioItemId,
            actor.workspaceId,
            // The PLAN's project: a Feature that has moved elsewhere must not receive this
            // plan's Release, which is the state `assertReferences` rejects on the next save.
            plan.projectId,
            {
              window,
              ...(spansReleases || ownsOtherRelease ? {} : { releaseId: plan.releaseId }),
            },
            tx,
          );
          if (!written) {
            skipped.push({
              portfolioItemId: feature.portfolioItemId,
              itemKey: feature.itemKey,
              reason: 'archived',
            });
            continue;
          }
          featuresUpdated += 1;

          if (ownsOtherRelease) {
            // Reported ahead of the window mismatch: this Feature's Release was left alone because it
            // is committed elsewhere, which is a different fact from the plan's window not matching.
            skipped.push({
              portfolioItemId: feature.portfolioItemId,
              itemKey: feature.itemKey,
              reason: 'other_release',
            });
          } else if (spansReleases) {
            // Dates written, Release deliberately not. Reported once per Feature because that is
            // the row the planner has to fix.
            skipped.push({
              portfolioItemId: feature.portfolioItemId,
              itemKey: feature.itemKey,
              reason: 'release_span_mismatch',
            });
          }
        }

        await this.repo.setStatus(id, actor.workspaceId, 'published', actor.sub, tx);
      });
    } else {
      await this.repo.setStatus(id, actor.workspaceId, 'published', actor.sub);
    }

    return {
      // The DETAIL, not the bare plan: the client re-renders the grid from this response, and
      // a publish changes what every row may do.
      plan: await this.getPlanDetail(actor, id),
      fieldsUpdated: options.updateFields,
      featuresUpdated,
      skipped,
    };
  }

  /**
   * Revert to draft so the plan can be edited again.
   *
   * The agile ALM tool: "No changes are made to the field values in the portfolio items" — the Release and
   * planned dates a publish wrote STAY on the Features, and clearing them is manual. That is
   * stated in the response rather than left for a planner to discover, because "revert" reads
   * like an undo and here it is not one.
   *
   * `published_at` is also left in place: it records that a publish happened, which is what
   * allows re-publishing a plan that has since been emptied.
   */
  async revertPlan(actor: JwtPayload, id: string): Promise<RevertResult> {
    const plan = await this.repo.findById(id, actor.workspaceId);
    if (!plan) throw new NotFoundException('CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found');
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:publish');
    /**
     * Guarded, and it is worth saying why this is NOT an "undo" that has to stay open.
     *
     * Revert unpublishes so the plan can be EDITED again, and the agile ALM tool is explicit that it rolls back
     * nothing — "No changes are made to the field values in the portfolio items". So it does not
     * undo the writes a publish made, and on an archived project the editing it exists to unlock is
     * refused anyway. Restoring the project is the one action that reopens all of this.
     */
    await this.projects.assertProjectWritable(actor.workspaceId, plan.projectId);

    if (plan.status !== 'published') {
      throw new PreconditionFailedException(
        'CAPACITY_PLAN_NOT_PUBLISHED',
        'This plan is already a draft',
      );
    }

    await this.repo.setStatus(id, actor.workspaceId, 'draft', null);
    return { plan: await this.getPlanDetail(actor, id), fieldsRolledBack: false };
  }

  /**
   * The agile ALM tool's Calculate Capacity Forecast, for ONE team.
   *
   * The agile ALM tool "produces estimates for a single team and does not respect the Parent/Child
   * hierarchy", so this is scoped per team rather than proposing capacities for a whole plan
   * at once — a departure from the API sketch in the Phase 5 spec, which had one plan-wide
   * `POST /:id/forecast`. Per team is both what the agile ALM tool does and what the planner needs: the
   * availability and complexity inputs describe one team's next window, not every team's.
   *
   * READ-ONLY. It computes a number and returns it; the planner still commits it through the
   * existing `PATCH /:id/teams/:teamId` (which is what `capacity:manage` guards). That split
   * is deliberate — being shown a forecast is not the same act as adopting it, and a forecast
   * that wrote itself into the plan would overwrite a considered figure with an automated
   * one.
   *
   * The window comes from the PLAN's planned dates, not from a request parameter: the
   * forecast has to answer "can this team deliver the work in THIS plan", and letting the
   * client pass its own window would let two callers get different answers for one plan.
   */
  async forecastTeamCapacity(
    actor: JwtPayload,
    id: string,
    teamId: string,
    options: {
      availabilityPct: number;
      complexity: ForecastComplexity;
      /**
       * The BA's supplied velocity, per iteration, in the plan's unit — "proposes capacities
       * from a supplied historic velocity" (`02_Capacity_Planning/SRS.md:142`). Optional: with
       * nothing supplied this is the agile ALM tool's forecast, sampled from the team's own history.
       */
      velocityPerIteration?: number | null;
    },
  ): Promise<ForecastResult> {
    const plan = await this.getPlan(actor, id);
    // `capacity:view`, not `manage`: this reads history and writes nothing, and a stakeholder
    // who can see a plan can ask what it is worth. The write stays gated separately.
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:view');
    await this.requirePlanTeam(id, teamId);

    const samples = await this.repo.teamVelocitySamples(
      plan.projectId,
      teamId,
      actor.workspaceId,
      FORECAST_HISTORY_DAYS,
    );

    const supplied = (options.velocityPerIteration ?? 0) > 0;
    // Only asked for when it can matter: a supplied velocity with no history to average is the
    // one case that needs the project's cadence, and this is a second query.
    const fallbackIterationDays =
      supplied && samples.length === 0
        ? await this.repo.projectIterationCadenceDays(plan.projectId, actor.workspaceId)
        : null;

    return forecastCapacity({
      samples,
      unit: plan.unit,
      windowDays: windowDays(planWindow(plan)),
      availabilityPct: options.availabilityPct,
      complexity: options.complexity,
      velocityPerIteration: options.velocityPerIteration ?? null,
      fallbackIterationDays,
      // Derived from the ids, so the same team on the same plan sees the same number on
      // every replica and after every deploy.
      seed: forecastSeed(id, teamId),
    });
  }

  async removeTeam(actor: JwtPayload, id: string, teamId: string): Promise<CapacityPlanView> {
    const plan = await this.requireDraft(actor, id);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');
    await this.requirePlanTeam(id, teamId);

    /**
     * The team's rows go back to UNALLOCATED — they are not deleted, and the removal is not refused.
     *
     * The BA states it twice: "removed Teams move their allocation rows back to Unallocated" (AC-005)
     * and "its allocation rows become unassigned so the demand can be reassigned". This used to throw
     * `CAPACITY_TEAM_HAS_ALLOCATIONS`, which left a planner with no way forward at all: the demand
     * could only be moved by hand, row by row, and a team whose project link was missing had no row in
     * the picker to move anything from.
     *
     * The demand SURVIVES because that is the point — a plan that forgets what it was committed to
     * when a team leaves is worse than one that refuses to let the team leave.
     */
    const rows = await this.repo.listAllocationsForTeam(id, teamId);

    await this.uow.run(async (tx) => {
      for (const row of rows) {
        /**
         * At most ONE unassigned row may exist per (plan, Feature) — `uq_capacity_allocation_unassigned`
         * — so a Feature that is ALREADY parked cannot simply take a second one. Its demand is merged
         * into the row that is there and this one is deleted.
         */
        const parked = await this.repo.findAllocationFor(id, row.portfolioItemId, null);
        if (parked) {
          const merged = mergeParked([parked, row]);
          await this.repo.updateAllocation(parked.id, merged, tx);
          await this.repo.deleteAllocation(row.id, tx);
          continue;
        }
        /**
         * Otherwise the row itself becomes the parked one. `isPrimary` is cleared because
         * `ck_capacity_primary_has_team` forbids a primary with no team — and because an unassigned
         * row names nobody to own the work.
         */
        await this.repo.updateAllocation(row.id, { teamId: null, isPrimary: false }, tx);
      }

      /**
       * A Feature that LOST its owner but still has other teams gets one back.
       *
       * Same rule `removeAllocation` applies: team rows with no primary read "as unassigned while
       * teams are demonstrably working on it", and a unique index cannot catch an absence.
       */
      for (const row of rows.filter((r) => r.isPrimary)) {
        const next = await this.repo.oldestTeamAllocation(id, row.portfolioItemId, tx);
        if (next) await this.repo.updateAllocation(next.id, { isPrimary: true }, tx);
      }

      await this.repo.removeTeam(id, teamId, tx);
    });

    return this.getPlan(actor, id);
  }

  // ── Allocations ───────────────────────────────────────────────────────────

  /**
   * Commit demand: this much of this Feature, to this Team (or to the Unallocated bucket).
   *
   * SETS the row for an existing (plan, Feature, team) triple rather than creating a second one, and
   * rather than adding to it: The agile ALM tool models sharing as one row PER TEAM under a Feature, so two rows
   * for the same pair would double-count that team's demand, and adding meant re-applying the same
   * dialog doubled it instead.
   */
  async allocate(
    actor: JwtPayload,
    planId: string,
    input: CreateCapacityAllocationInput,
  ): Promise<CapacityPlanDetail> {
    const plan = await this.requireDraft(actor, planId);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');

    // Called for the CHECK **and** for the value: the target must be a Feature in the plan's project
    // and not archived, and a blank Estimate copies that Feature's own top-down estimate into the row.
    const teamId = input.teamId ?? null;
    // A team-assigned allocation may cross releases (§226); a parked one must satisfy eligibility.
    const item = await this.requireAllocatableFeature(
      actor,
      plan,
      input.portfolioItemId,
      teamId !== null,
    );
    if (teamId !== null) await this.requirePlanTeam(planId, teamId);

    /**
     * A blank Estimate COPIES the Feature's top-down estimate into the row and labels it
     * `feature_estimate` (§185). A supplied one is stored as `manual` (§186).
     *
     * Between 0077 and 0101 a blank stored NULL and the charge was resolved per read. That made a
     * planner's committed demand move whenever anyone edited the Feature's Refined Estimate — the plan
     * changed with no action on the plan — and made §337's `SUM(allocation.value)` uncomputable from
     * the stored rows. The snapshot restores both; `source` is what keeps 0077's distinction between a
     * copied number and a typed one, which is why the value can be fixed at all.
     */
    const supplied = input.value !== undefined;
    const value = supplied ? input.value! : await this.featureEstimate(actor, plan, item);
    const source: CapacityAllocationSource = supplied ? 'manual' : 'feature_estimate';

    /**
     * Assigning a team CONSUMES the Feature's unallocated placeholder rather than adding beside it.
     *
     * The agile ALM tool and the BA both describe it as a move: "choosing a Team assigns the existing unallocated
     * row to that Team". Keeping both would count the Feature twice — once as parked demand and once
     * as the team's commitment — which is exactly what happened when adding and allocating became
     * two steps: `Add Features` leaves an unassigned row, and the first allocation then doubled it.
     */
    if (teamId !== null) {
      const parked = await this.repo.findAllocationFor(planId, input.portfolioItemId, null);
      if (parked) {
        const alreadyHasPrimary = await this.repo.hasPrimaryAllocation(
          planId,
          input.portfolioItemId,
        );
        /**
         * The parked row's own value SURVIVES an assignment that does not supply one — §244: "move
         * that existing row to the selected Team and keep its current allocation value."
         *
         * `supplied`, not "is the value non-null": every row carries a number now, so an omitted
         * Estimate has to be distinguished from a typed one by the request, not by the stored value.
         * Its `source` travels with it untouched, because moving a row does not change where its
         * number came from.
         */
        await this.repo.updateAllocation(parked.id, {
          teamId,
          ...(supplied ? { value: String(value), source } : {}),
          isPrimary: !alreadyHasPrimary,
        });
        return this.getPlanDetail(actor, planId);
      }
    }

    const existing = await this.repo.findAllocationFor(planId, input.portfolioItemId, teamId);
    if (existing) {
      /**
       * SETS this team's slice, it does not add to it.
       *
       * The BA is explicit — "Re-applying allocation replaces the Feature's Team allocation rows" —
       * and so is the agile ALM tool's dialog, which asks for "the number of story points or count to allocate for
       * this team". Adding meant applying the same dialog twice doubled committed demand, and there
       * was no way to correct a slice downwards through this path at all.
       *
       * A blank value leaves the existing slice alone rather than overwriting it with the Feature's
       * estimate: re-copying is `updateAllocation` with an explicit null, which is a different
       * request, and the dialog pre-fills the current value so a blank field there means "cleared".
       */
      if (supplied) {
        await this.repo.updateAllocation(existing.id, { value: String(value), source });
      }
    } else {
      /**
       * The FIRST team to receive work on a Feature becomes its primary.
       *
       * The agile ALM tool's order of operations is assign-then-allocate: "assign the portfolio item to one
       * primary team and then allocate points... to the additional teams". Inferring it from the
       * first allocation matches that without making the planner answer a second question, and
       * leaves the choice changeable afterwards.
       *
       * An Unallocated row is never primary — it names no team to own the work, which is also
       * what `ck_capacity_primary_has_team` enforces.
       */
      const alreadyHasPrimary =
        teamId === null
          ? true
          : await this.repo.hasPrimaryAllocation(planId, input.portfolioItemId);
      await this.repo.createAllocation({
        planId,
        portfolioItemId: input.portfolioItemId,
        teamId,
        value: String(value),
        source,
        isPrimary: teamId !== null && !alreadyHasPrimary,
      });
    }

    return this.getPlanDetail(actor, planId);
  }

  async updateAllocation(
    actor: JwtPayload,
    planId: string,
    allocationId: string,
    input: UpdateCapacityAllocationInput,
  ): Promise<CapacityPlanDetail> {
    const plan = await this.requireDraft(actor, planId);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');

    const allocation = await this.repo.findAllocation(allocationId, planId);
    if (!allocation) {
      throw new NotFoundException('CAPACITY_ALLOCATION_NOT_FOUND', 'Allocation not found');
    }
    // Moving to a team requires that team to be ON the plan; moving to null parks it in the
    // Unallocated bucket, which needs no membership.
    if (input.teamId) await this.requirePlanTeam(planId, input.teamId);

    /**
     * The destination slot must be free, because the database says so.
     *
     * `uq_capacity_allocation_team` allows one row per (plan, item, team) and
     * `uq_capacity_allocation_unassigned` one parked row per (plan, item). Moving onto an occupied
     * slot used to reach Postgres and surface as `INTERNAL_ERROR` 500 — a planner's ordinary mistake
     * reported as a server fault. Named codes let the client say what happened instead.
     */
    if (input.teamId !== undefined && input.teamId !== allocation.teamId) {
      const occupied = await this.repo.findAllocationFor(
        planId,
        allocation.portfolioItemId,
        input.teamId,
      );
      if (occupied) {
        throw new ConflictException(
          input.teamId === null
            ? 'CAPACITY_ALLOCATION_ALREADY_UNASSIGNED'
            : 'CAPACITY_ALLOCATION_TEAM_TAKEN',
          input.teamId === null
            ? 'That Feature already has an unassigned row on this plan'
            : 'That team already holds an allocation of this Feature',
        );
      }
    }

    /**
     * `value: null` RE-COPIES the Feature's current top-down estimate, relabelled `feature_estimate`.
     *
     * It used to write NULL and hand the row back to a resolving read. There is no NULL to write any
     * more (§11 makes the value fixed), and the gesture it expresses — a planner emptying the cell —
     * still has a meaning: "charge whatever this Feature is estimated at", which is §185 evaluated
     * again now. The number is taken at THIS moment, so a re-copy is a deliberate re-baseline rather
     * than a subscription to future edits.
     */
    let recopied: number | null = null;
    if (input.value === null) {
      const item = await this.portfolioItems.getItem(actor, allocation.portfolioItemId);
      recopied = await this.featureEstimate(actor, plan, item);
    }

    // A PARKED row gaining a team becomes the primary when the Feature has no primary yet — the
    // mirror of the park path below. Without it the quick Planned Team Assignment selector moves the
    // parked row to the team but leaves primaryTeamId null, so the selector reads "Not assigned"
    // (CP-032). Scoped to the park→team transition only: a team-to-team MOVE must not change primary
    // status (the Feature keeps its owner). Promote only when nobody else is primary.
    const gainsTeam =
      input.teamId !== undefined &&
      input.teamId !== null &&
      allocation.teamId === null &&
      !allocation.isPrimary;
    const promoteToPrimary =
      gainsTeam && !(await this.repo.hasPrimaryAllocation(planId, allocation.portfolioItemId));

    await this.uow.run(async (tx) => {
      // Parking a row in the Unallocated bucket strips its primary flag: the check constraint
      // forbids a primary with no team, so this is the difference between a clear rule and a
      // constraint violation the planner would see as a crash.
      const losesTeam = input.teamId === null && allocation.isPrimary;
      await this.repo.updateAllocation(
        allocationId,
        {
          // `undefined` leaves the value and its source untouched.
          ...(input.value === undefined
            ? {}
            : input.value === null
              ? { value: String(recopied), source: 'feature_estimate' as const }
              : { value: String(input.value), source: 'manual' as const }),
          ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
          ...(losesTeam ? { isPrimary: false } : {}),
          ...(promoteToPrimary ? { isPrimary: true } : {}),
        },
        tx,
      );
      // ...and hands the assignment to whoever is left, so the Feature does not silently become
      // unassigned while teams still hold work on it.
      if (losesTeam) {
        const next = await this.repo.oldestTeamAllocation(planId, allocation.portfolioItemId, tx);
        if (next) await this.repo.updateAllocation(next.id, { isPrimary: true }, tx);
      }
    });
    return this.getPlanDetail(actor, planId);
  }

  /**
   * Make one allocation the Feature's primary team assignment.
   *
   * The agile ALM tool's Items tab shows exactly one team per Feature in "Planned Project Assignment", so
   * this clears the previous primary in the SAME transaction. Two statements outside one would
   * briefly leave the Feature with two owners or none, and `uq_capacity_allocation_primary`
   * would reject the first ordering outright.
   */
  async setPrimaryAllocation(
    actor: JwtPayload,
    planId: string,
    allocationId: string,
  ): Promise<CapacityPlanDetail> {
    const plan = await this.requireDraft(actor, planId);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');

    const allocation = await this.repo.findAllocation(allocationId, planId);
    if (!allocation) {
      throw new NotFoundException('CAPACITY_ALLOCATION_NOT_FOUND', 'Allocation not found');
    }
    // An Unallocated row has no team to be the owner, so this is a refusal rather than a no-op:
    // silently ignoring it would leave the planner thinking the assignment had moved.
    if (allocation.teamId === null) {
      throw new PreconditionFailedException(
        'CAPACITY_PRIMARY_NEEDS_TEAM',
        'Assign this Feature to a team before making it the primary assignment',
      );
    }

    await this.uow.run(async (tx) => {
      await this.repo.clearPrimaryAllocations(planId, allocation.portfolioItemId, tx);
      await this.repo.updateAllocation(allocationId, { isPrimary: true }, tx);
    });
    return this.getPlanDetail(actor, planId);
  }

  /**
   * The agile ALM tool's `Remove From Plan`: take a Feature off the plan entirely.
   *
   * ONE call, ONE transaction. The client used to do this by looping a DELETE per allocation — a split
   * Feature meant one request per team — so a failure midway left the Feature half-removed: still on
   * the plan, still counted, but missing the teams the earlier calls had already dropped. There was no
   * request that expressed "remove this Feature", which is the decision a planner actually makes.
   *
   * The BA says the same thing: "removes every allocation row for that Feature across all Teams in the
   * Plan". The Feature itself is untouched — this is a planning decision, not a portfolio one.
   *
   * No primary promotion here, unlike `removeAllocation`: every row for this Feature is going, so there
   * is nothing left to own it.
   */
  async removeItemFromPlan(
    actor: JwtPayload,
    planId: string,
    portfolioItemId: string,
  ): Promise<CapacityPlanDetail> {
    const plan = await this.requireDraft(actor, planId);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');

    const rows = await this.repo.listAllocationsForItem(planId, portfolioItemId);
    if (rows.length === 0) {
      throw new NotFoundException(
        'CAPACITY_ALLOCATION_NOT_FOUND',
        'That Feature is not on this plan',
      );
    }

    await this.uow.run(async (tx) => {
      for (const row of rows) await this.repo.deleteAllocation(row.id, tx);
    });

    return this.getPlanDetail(actor, planId);
  }

  async removeAllocation(
    actor: JwtPayload,
    planId: string,
    allocationId: string,
  ): Promise<CapacityPlanDetail> {
    const plan = await this.requireDraft(actor, planId);
    await this.access.assertProjectPermission(actor, plan.projectId, 'capacity:manage');

    const allocation = await this.repo.findAllocation(allocationId, planId);
    if (!allocation) {
      throw new NotFoundException('CAPACITY_ALLOCATION_NOT_FOUND', 'Allocation not found');
    }
    await this.uow.run(async (tx) => {
      await this.repo.deleteAllocation(allocationId, tx);
      /**
       * Removing the primary PROMOTES the next remaining team allocation.
       *
       * A Feature with allocations but no primary would read as unassigned on the Items tab —
       * The agile ALM tool shows a warning icon for that — while teams are demonstrably working on it. The
       * oldest remaining allocation inherits, for the same reason the first one was chosen.
       */
      if (allocation.isPrimary) {
        const next = await this.repo.oldestTeamAllocation(planId, allocation.portfolioItemId, tx);
        if (next) await this.repo.updateAllocation(next.id, { isPrimary: true }, tx);
      }
    });
    return this.getPlanDetail(actor, planId);
  }

  /**
   * The full plan: teams with their metrics and warnings, plus every allocation.
   *
   * Assembled here rather than in the repository because the tier needs the workspace
   * estimate map and the warnings are pure domain logic — the repository supplies raw
   * numbers, this decides what they mean.
   */
  /**
   * The agile ALM tool's `Move To Another Plan`: relocate one Feature's planning from this plan to another.
   *
   * The agile ALM tool reaches it from the item's gear "in Projects By Total, Projects By Release, or Items tabs",
   * offers a searchable list of eligible plans, an `Update the Release to match the selected plan`
   * checkbox, and two buttons — `Move` and `Move and Republish the Plan`. All of that is honoured
   * here, including the rule that decides the second button exists at all: "if the new plan is in a
   * Published state, moving this item unpublishes the plan".
   *
   * ELIGIBLE means same project and not this plan. A plan is per (project, release), and an
   * allocation is only valid when the Feature belongs to the plan's project — moving across projects
   * would create a row `requireAllocatableFeature` refuses on the next write.
   *
   * The Feature's own Release is the reason the checkbox exists. A Feature committed to release A
   * cannot be planned in a plan for release B (`CAPACITY_ALLOCATION_OTHER_RELEASE`), so a move
   * between releases either updates the Feature or must be refused — this returns
   * `CAPACITY_MOVE_RELEASE_MISMATCH` rather than moving work between releases by implication.
   */
  async moveItemToPlan(
    actor: JwtPayload,
    planId: string,
    input: {
      portfolioItemId: string;
      targetPlanId: string;
      updateRelease: boolean;
      republish: boolean;
    },
  ): Promise<MoveItemResult> {
    const source = await this.requireDraft(actor, planId);
    await this.access.assertProjectPermission(actor, source.projectId, 'capacity:manage');

    if (input.targetPlanId === planId) {
      throw new PreconditionFailedException(
        'CAPACITY_MOVE_SAME_PLAN',
        'That Feature is already on this plan',
      );
    }

    const target = await this.repo.findById(input.targetPlanId, actor.workspaceId);
    if (!target) {
      throw new NotFoundException('CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found');
    }
    if (target.projectId !== source.projectId) {
      throw new PreconditionFailedException(
        'CAPACITY_MOVE_OTHER_PROJECT',
        'A plan can only take Features from its own project',
      );
    }
    /**
     * UNPUBLISHING the target is a `capacity:publish` act, and so is republishing it.
     *
     * Both are asserted here, before anything is written, rather than failing halfway with the rows
     * already relocated. The unpublish check was missing entirely: the move sets a published target
     * back to draft unconditionally, so a planner holding `capacity:manage` but not
     * `capacity:publish` could revert someone else's published plan — and hide it from every
     * Project Member with it (AC-013) — by moving one Feature onto it. `revertPlan` requires
     * `capacity:publish` for exactly that act, and the two paths must agree.
     */
    if (input.republish || target.status === 'published') {
      await this.access.assertProjectPermission(actor, target.projectId, 'capacity:publish');
    }

    const rows = await this.repo.listAllocationsForItem(planId, input.portfolioItemId);
    if (rows.length === 0) {
      throw new NotFoundException(
        'CAPACITY_ALLOCATION_NOT_FOUND',
        'That Feature is not on this plan',
      );
    }

    /**
     * The agile ALM tool shows a message and offers `Remove Only` when the target already holds the item.
     *
     * Refused rather than merged: the target's rows carry their own allocated values, and folding
     * this plan's numbers into them would change a commitment the planner never looked at.
     */
    const onTarget = await this.repo.listAllocationsForItem(
      input.targetPlanId,
      input.portfolioItemId,
    );
    if (onTarget.length > 0) {
      throw new PreconditionFailedException(
        'CAPACITY_MOVE_ALREADY_ON_TARGET',
        'That Feature is already on the selected plan — remove it from this one instead',
      );
    }

    const item = await this.portfolioItems.getItem(actor, input.portfolioItemId);
    const releaseMoves = item.releaseId !== null && item.releaseId !== target.releaseId;
    if (releaseMoves && !input.updateRelease) {
      throw new PreconditionFailedException(
        'CAPACITY_MOVE_RELEASE_MISMATCH',
        "That Feature belongs to another release — choose to update its Release to match the plan's",
      );
    }

    /**
     * Which rows can keep their team: the target plan has to hold that team already.
     *
     * Resolved BEFORE the transaction so a target missing every team is known up front, and so the
     * membership reads are not interleaved with the writes that depend on them.
     */
    const teamIds = [...new Set(rows.map((row) => row.teamId).filter((id) => id !== null))];
    const teamsOnTarget = new Set<string>();
    for (const teamId of teamIds) {
      if (await this.repo.findTeam(input.targetPlanId, teamId)) teamsOnTarget.add(teamId);
    }

    const carriable = rows.filter((row) => row.teamId !== null && teamsOnTarget.has(row.teamId));
    // The rows that cannot keep their team — kept as ROWS, not counted, because their values have
    // to be folded into the parked row rather than discarded.
    const lost = rows.filter((row) => !carriable.includes(row));
    const parkable = lost.length;
    const targetUnpublished = target.status === 'published';

    /**
     * The Feature must arrive with an OWNER if it arrives with a team at all.
     *
     * A carried row keeps its own primary flag. But when the owner's team is ABSENT from the target,
     * nothing there would be primary — the state `removeAllocation` guards against, described there as
     * reading "as unassigned while teams are demonstrably working on it". A unique index cannot catch
     * an absence, so the first carried row takes the assignment. Decided before the loop because it is
     * a property of the whole move, not of one row.
     */
    const ownerSurvives = carriable.some((row) => row.isPrimary);

    await this.uow.run(async (tx) => {
      for (const [at, row] of carriable.entries()) {
        await this.repo.createAllocation(
          {
            planId: input.targetPlanId,
            portfolioItemId: input.portfolioItemId,
            teamId: row.teamId,
            value: row.value,
            // A carried row is the SAME commitment on another plan, so its source travels with it.
            source: row.source,
            isPrimary: ownerSurvives ? row.isPrimary : at === 0,
          },
          tx,
        );
      }

      /**
       * Everything that could not keep its team becomes ONE unassigned row, not one per lost team:
       * the target has no way to tell those rows apart, so N of them would read as N commitments.
       *
       * Its value is the SUM of what those rows carried, folded with `mergeParked` — the same helper
       * `removeTeam` uses for the same situation. It used to be hard-coded `null`, which silently
       * destroyed every number a planner had typed for a team the target does not hold: FE-1 with
       * Team A = 8 and Team B = 5 moved to a plan holding only Team A arrived as 8 plus a valueless
       * placeholder, and the parked row then resolved through Refined → Preliminary, so the plan
       * reported an estimate nobody entered.
       */
      if (lost.length > 0) {
        await this.repo.createAllocation(
          {
            planId: input.targetPlanId,
            portfolioItemId: input.portfolioItemId,
            teamId: null,
            ...mergeParked(lost),
          },
          tx,
        );
      }

      for (const row of rows) await this.repo.deleteAllocation(row.id, tx);

      if (releaseMoves) {
        await this.repo.setFeatureRelease(
          input.portfolioItemId,
          actor.workspaceId,
          target.releaseId,
          tx,
        );
      }

      // The agile ALM tool: the move itself unpublishes the target. Its published numbers described a plan that
      // did not carry this Feature, so leaving it published would publish a claim nobody made.
      if (targetUnpublished) {
        await this.repo.setStatus(input.targetPlanId, actor.workspaceId, 'draft', null, tx);
      }
    });

    /**
     * `Move and Republish the Plan`, after the move commits.
     *
     * Outside the transaction on purpose: publishing writes Release and planned dates onto every
     * Feature on the target and reports what it skipped, and rolling THAT back because of a later
     * failure would leave the plan and the Features it already touched disagreeing.
     */
    let targetRepublished = false;
    if (input.republish) {
      await this.publishPlan(actor, input.targetPlanId, { updateFields: true });
      targetRepublished = true;
    }

    return {
      plan: await this.getPlanDetail(actor, planId),
      targetPlanId: target.id,
      targetPlanKey: target.planKey,
      carried: carriable.length,
      parked: parkable > 0 ? 1 : 0,
      releaseUpdated: releaseMoves,
      targetUnpublished,
      targetRepublished,
    };
  }

  async getPlanDetail(actor: JwtPayload, id: string): Promise<CapacityPlanDetail> {
    const plan = await this.getPlan(actor, id);
    const map = await this.estimateMaps.forProject(plan.projectId);
    const rows = await this.repo.listAllocations(plan);

    const inUnit = (size: PreliminaryEstimateSize) =>
      plan.unit === 'points' ? map[size].points : map[size].count;

    const allocations: CapacityAllocationView[] = rows.map((row) => {
      /**
       * What this team is charged for this Feature: the STORED value, nothing resolved.
       *
       * Until 0101 a null value meant "charge the Feature's own estimate here" and was resolved on
       * every read through `resolveEstimate`. SRS §11 makes it a fixed value set during planning
       * (`fixed allocation.value set during planning/replanning`), and §337 defines Team Estimated as
       * `SUM(allocation.value)` — neither is expressible while the number is reconstructed per read,
       * and a resolving read moved a Draft plan's committed demand whenever anyone edited the
       * Feature's Refined Estimate. `source` says which of §185/§186 produced it.
       */
      const committed = Number(row.value);
      /**
       * An ARCHIVED Feature is charged NOTHING.
       *
       * The BA: an archived item "is not actionable planning demand". Its row stays visible so the
       * planner can see the stale commitment and remove it, but it contributes zero to the team's
       * load, to the plan totals and to the cutline. The stored value is still returned, so the row
       * explains itself rather than looking empty.
       */
      const archived = row.itemArchivedAt !== null;
      /**
       * Which of the agile ALM tool's three candidates this row's number came from, for the `Estimate` tooltip.
       *
       * The agile ALM tool's panel on the team tab lists Allocated / Refined / Preliminary with the one in force
       * ticked and the other two struck through, so the client needs the winner named. Resolved here
       * rather than in the browser for the usual reason: `resolveEstimate` is the rule, and a second
       * copy of it in TypeScript would be free to disagree with the arithmetic beside it.
       *
       * `totalAllocated` is THIS row's committed value, not the Feature's sum: the tooltip is about
       * this Team's row, and folding in the other teams' slices would tick `allocated` on a row that
       * commits nothing.
       */
      const tier = resolveEstimate({
        totalAllocated: committed,
        refined: row.refined,
        preliminary: inUnit(row.preliminarySize),
      }).tier;
      return {
        id: row.id,
        planId: row.planId,
        portfolioItemId: row.portfolioItemId,
        teamId: row.teamId,
        isPrimary: row.isPrimary,
        value: row.value,
        source: row.source,
        tier,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        itemKey: row.itemKey,
        name: row.name,
        rank: row.rank,
        state: row.state,
        projectId: row.itemProjectId,
        projectName: row.itemProjectName,
        archived,
        estimateBreakdown: {
          refined: row.refined,
          // 0 means the workspace maps this size to nothing, which reads as "no estimate" rather
          // than as a real zero — the tooltip shows a dash for it.
          preliminary: inUnit(row.preliminarySize) || null,
        },
        metrics: {
          // Zeroed for an archived Feature, so the row reads as the nothing it now contributes — and
          // so the sums below, which add these up, cannot pick it back up.
          complete: archived ? 0 : row.complete,
          rollup: archived ? 0 : row.rollup,
          estimated: archived ? 0 : committed,
          // A Feature row has no capacity of its own — the ceiling belongs to the team.
          capacity: null,
          warnings: computeCapacityWarnings({
            kind: 'feature',
            rollup: row.rollup,
            estimated: committed,
            capacity: null,
            /**
             * The agile ALM tool's "Feature Missing Estimate Error" on a row that commits nothing.
             *
             * A zero commitment is what a Feature added through the Team picker starts at (§246), and
             * what a blank Estimate copies when the Feature has neither a Refined forecast nor a
             * sized Preliminary. Either way there is no demand to plan against, which is what the
             * warning says.
             */
            tier: committed > 0 ? 'allocated' : 'none',
          }),
        },
      };
    });

    /**
     * A team row is the SUM OF ITS OWN ALLOCATION ROWS — all four numbers, from one source.
     *
     * SRS §341/§347 state it exactly that way: "Team Rollup = SUM(Feature/Team Rollup for allocation
     * rows in Team)", "Team Complete = SUM(Feature/Team Complete for allocation rows in Team)". It used
     * to be a SEPARATE per-team aggregate query (`repo.teamMetrics`, over its own copy of the child
     * predicate) while `estimated` was already summed from the rows here — two definitions of one
     * number, free to disagree, and they did: the team query narrowed children with a strict
     * `work_items.team_id = ?` where the row subquery falls back to the Feature's owner. Summing the
     * rows makes the Team row, the expanded Feature rows under it and the plan header (which is the sum
     * of the team rows, `planTotals`) arithmetically incapable of disagreeing — which is `AC-017`'s
     * reconciliation requirement and the `P5-CP-029` retest's "Team slices must be consistent with the
     * Feature/Plan totals".
     *
     * Archived Features drop out for free: their row metrics are zeroed above (§15).
     */
    const teams = plan.teams.map((team) => {
      const mine = allocations.filter((a) => a.teamId === team.teamId);
      const complete = mine.reduce((sum, a) => sum + a.metrics.complete, 0);
      const rollup = mine.reduce((sum, a) => sum + a.metrics.rollup, 0);
      const estimated = mine.reduce((sum, a) => sum + a.metrics.estimated, 0);
      const capacity = team.capacity === null ? null : Number(team.capacity);

      return {
        ...team,
        metrics: {
          complete,
          rollup,
          estimated,
          capacity,
          warnings: computeCapacityWarnings({
            kind: 'team',
            rollup,
            estimated,
            capacity,
          }),
        },
      };
    });

    /**
     * The agile ALM tool's Items tab: ONE row per Feature, in rank order, with its own totals.
     *
     * Distinct by Feature because a Feature shared between two teams is one item with two
     * allocations — the agile ALM tool lists it once and nests the allocations underneath.
     */
    // Built from the REPOSITORY rows, not the client view: `rank` and the Feature's own totals
    // are inputs to this aggregation, not fields any client needs on an allocation. `rows` and
    // `allocations` are 1:1 in order, so the tier already resolved above is reused by index
    // rather than resolved a second time.
    const items: CapacityPlanItem[] = [];
    const seen = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
      const at = seen.get(row.portfolioItemId);
      if (at === undefined) {
        seen.set(row.portfolioItemId, items.length);
        items.push({
          portfolioItemId: row.portfolioItemId,
          itemKey: row.itemKey,
          name: row.name,
          rank: row.rank,
          projectId: row.itemProjectId,
          projectName: row.itemProjectName,
          teamId: row.itemTeamId,
          teamName: row.itemTeamName,
          releaseId: row.itemReleaseId,
          /**
           * A TEAM row's charge counts; an unallocated placeholder's does not.
           *
           * The BA is explicit (AC-014, §11): "Unallocated rows do not count toward Total
           * Allocated. An Unallocated placeholder does not override Refined or Preliminary." A
           * Feature holding both a team row and a parked row was reporting the sum of the two —
           * live proof was `CP-8`/`FE-640729683` showing 8 for a 3-point commitment beside a
           * 5-point placeholder — and that inflated number then fed the cutline while the plan
           * header (which sums team rows only) disagreed with it.
           *
           * A Feature with ONLY a parked row still shows its own estimate: the placeholder is
           * skipped here and `parkedEstimate` supplies the fallback below, so "planned but not yet
           * assigned" reads as the Feature's size rather than as zero.
           */
          // Accumulates `Total Allocated` — SUM over TEAM-ASSIGNED rows only — and is replaced after
          // the loop by AC-014's resolution. A parked row contributes nothing here by design (§294):
          // "An Unallocated placeholder does not override Refined or Preliminary."
          estimated: row.teamId === null ? 0 : allocations[index].metrics.estimated,
          /**
           * An ARCHIVED Feature charges nothing, on BOTH tabs.
           *
           * `estimated` was already zeroed for an archived Feature (`:1194` does the same for the
           * allocation row) but `rollup` and `complete` were assigned unconditionally, so the
           * Features tab showed Rollup 21 / Estimated 0 and raised `rollup_exceeds_estimated` —
           * "Rollup exceeds Estimated" — for work contributing nothing. Meanwhile the team grid
           * zeroes an archived Feature's allocation rows, so
           * Teams-by-Total showed 0 for the same Feature: two tabs, two numbers, one of them
           * warning about the other. SRS §15 calls archived work "not actionable planning demand",
           * and AC-017 requires the split views to reconcile.
           */
          rollup: row.itemArchivedAt !== null ? 0 : row.itemRollup,
          complete: row.itemArchivedAt !== null ? 0 : row.itemComplete,
          archived: row.itemArchivedAt !== null,
          // Filled in after the loop: all three depend on the FINAL aggregate, so computing them per
          // row would report the first allocation's view of a Feature that has several.
          tier: 'none',
          warnings: [],
          estimateBreakdown: {
            allocated: row.teamId === null ? null : allocations[index].metrics.estimated,
            refined: row.refined,
            // 0 means the workspace maps this size to nothing, which reads as "no estimate" rather
            // than as a real zero — the same treatment the allocation row's tooltip gets.
            preliminary: inUnit(row.preliminarySize) || null,
          },
          teamIds: row.teamId === null ? [] : [row.teamId],
          // The agile ALM tool's Planned Team Assignment shows the team that OWNS the Feature, not a count.
          primaryTeamId: row.isPrimary ? row.teamId : null,
          unallocated: row.teamId === null,
        });
      } else {
        const item = items[at];
        if (row.teamId !== null) {
          item.estimated += allocations[index].metrics.estimated;
          item.estimateBreakdown.allocated =
            (item.estimateBreakdown.allocated ?? 0) + allocations[index].metrics.estimated;
        }
        if (row.teamId === null) item.unallocated = true;
        else item.teamIds.push(row.teamId);
        if (row.isPrimary) item.primaryTeamId = row.teamId;
      }
    }

    /**
     * `Feature Estimated` — the planning view, AC-014, applied to the whole Feature.
     *
     * "Total Allocated, Refined Estimate, then temporary Preliminary Estimate mapping", where Total
     * Allocated counts only team-assigned rows. Each row's own number is now a fixed stored value, so
     * this is the ONE place a tier is still resolved, and it is resolved from the aggregate — which is
     * what it always described.
     *
     * It used to be inferred instead: the item took whichever tier its first allocation row reported,
     * upgraded to `allocated` if any row had an explicit value, and a Feature with only a parked row
     * had its estimate copied from that row in a second pass. Three approximations of one rule; a
     * Feature holding a 0-valued team row beside a Refined forecast of 21, for instance, reported the
     * commitment's tier while showing neither number.
     *
     * The warnings follow the same aggregate, `kind: 'feature'` — a Feature has no capacity of its
     * own, so the capacity comparisons cannot fire, and `tier: 'none'` is the agile ALM tool's "Feature Missing
     * Estimate Error".
     */
    for (const item of items) {
      const resolved = resolveEstimate({
        totalAllocated: item.estimated,
        refined: item.estimateBreakdown.refined,
        preliminary: item.estimateBreakdown.preliminary ?? 0,
      });
      item.tier = resolved.tier;
      // An archived Feature is charged nothing on either tab (§15) — but the tier still reports where
      // the number WOULD have come from, so the row explains itself rather than looking empty.
      item.estimated = item.archived ? 0 : resolved.value;
      item.warnings = computeCapacityWarnings({
        kind: 'feature',
        rollup: item.rollup,
        estimated: item.estimated,
        capacity: null,
        tier: resolved.tier,
      });
    }

    // Ordered by the repository's rank ordering, EXCEPT that it puts unallocated rows last.
    // The cutline accumulates strictly down rank, so this restores it.
    items.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));

    /**
     * The agile ALM tool's cutline: "Items above the cutline fit within the defined plan capacity."
     *
     * PLAN-wide, on the item list, in rank order — the shape the agile ALM tool documents, on the plan's Items tab.
     * An earlier version drew it per team on the team grid; that answered a different question (what one
     * team drops) than the one the line answers (what this PLAN drops).
     */
    const itemCutlineIndex = computeCutlineIndex(
      items.map((item) => item.estimated),
      totalEnteredCapacity(teams),
    );

    /**
     * The PLAN's own warnings, over the summed team rows.
     *
     * `kind: 'team'` because a plan is judged by exactly the team rules — its demand against its
     * capacity — and the two Feature rules (missing estimate, rollup vs estimated) belong to a single
     * Feature, not to an aggregate of them. `rollup_exceeds_estimated` still applies: plan-wide,
     * children having outgrown the commitment is the same fact it always was.
     *
     * `totalEnteredCapacity` is the same denominator the cutline above uses, so a plan whose cutline
     * drops items cannot report itself inside capacity. It is null while nobody has entered one, which
     * `computeCapacityWarnings` reports as `team_missing_capacity` — honest for a plan that cannot be
     * measured yet, and the same answer the team rows give.
     *
     * Computed BEFORE the reader narrowing below, over every team: like `totalCapacity` and the
     * cutline, this is a fact about the plan. A reader shown the plan's totals with no warning on them
     * would be the exact defect this fixes, one scope down.
     */
    const planCapacity = totalEnteredCapacity(teams);
    const planWarnings = computeCapacityWarnings({
      kind: 'team',
      rollup: teams.reduce((sum, team) => sum + team.metrics.rollup, 0),
      estimated: teams.reduce((sum, team) => sum + team.metrics.estimated, 0),
      capacity: planCapacity,
    });

    /**
     * AC-010: a reader "sees only its assigned Team" inside a published plan.
     *
     * The TEAM rows and their allocations are narrowed to the teams this caller belongs to. What is
     * deliberately NOT narrowed: the plan's own totals, its item list and its cutline. Those are facts
     * about the PLAN, and a reader who could not see them would have their own team's numbers with
     * nothing to read them against — "18 of what?" — while the header, the bar and the cutline all
     * describe a whole a plan member is entitled to understand. The BA's rule is about whose ROWS a
     * reader may open, not about hiding the plan's size from someone who was shown the plan.
     *
     * A planner sees everything. A reader who belongs to no team on the plan sees no team rows, which
     * is the honest answer rather than an empty-looking error.
     */
    if (!(await this.canSeeDrafts(actor, plan.projectId))) {
      const mine = await this.teamIdsFor(actor);
      const visibleTeams = teams.filter((team) => mine.has(team.teamId));
      return {
        ...plan,
        teams: visibleTeams,
        items,
        itemCutlineIndex,
        warnings: planWarnings,
        allocations: allocations.filter((a) => a.teamId !== null && mine.has(a.teamId)),
        unallocated: allocations
          .filter((a) => a.teamId === null)
          .reduce((sum, a) => sum + a.metrics.estimated, 0),
      };
    }

    return {
      ...plan,
      teams,
      items,
      itemCutlineIndex,
      warnings: planWarnings,
      allocations,
      /** Demand parked without a team. Excluded from Total Allocated by design. */
      unallocated: allocations
        .filter((a) => a.teamId === null)
        .reduce((sum, a) => sum + a.metrics.estimated, 0),
    };
  }

  /**
   * The teams this caller is an ACTIVE member of, workspace-wide.
   *
   * Not narrowed to the plan's project: the caller's memberships are a property of the person, and the
   * only use is intersecting them with a plan's own teams — which are already project-scoped by
   * `assertTeamInProject`. Filtering twice would just be a longer way to the same set.
   */
  private async teamIdsFor(actor: JwtPayload): Promise<Set<string>> {
    const rows = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.workspaceId, actor.workspaceId),
          eq(teamMembers.userId, actor.sub),
          eq(teamMembers.status, 'active'),
        ),
      );
    return new Set(rows.map((row) => row.teamId));
  }

  /**
   * The allocation target must be a FEATURE in the plan's own project.
   *
   * Epics are not allocatable: only the lowest portfolio level attaches to the story
   * hierarchy, so an Epic has no children of its own to roll up and allocating to it would
   * produce a row whose Rollup is permanently zero.
   */
  private async requireAllocatableFeature(
    actor: JwtPayload,
    plan: CapacityPlan,
    portfolioItemId: string,
    /** True when a TEAM is being named — §226's Team picker ignores Release. */
    allowOtherRelease = false,
  ) {
    const item = await this.portfolioItems.getItem(actor, portfolioItemId);
    if (item.type !== 'feature') {
      throw new PreconditionFailedException(
        'CAPACITY_ALLOCATION_NOT_FEATURE',
        'Only a Feature can be allocated — an Epic rolls up through its Features',
      );
    }
    if (item.projectId !== plan.projectId) {
      // Its OWN code: this was reusing the release-mismatch code, so a project error read as a
      // date problem in the log and in whatever the client branched on.
      throw new PreconditionFailedException(
        'CAPACITY_ALLOCATION_WRONG_PROJECT',
        'That Feature belongs to a different project',
      );
    }
    /**
     * The three eligibility rules the BA flow states and this guard did not enforce (§4.4).
     *
     * The picker hides all three, but a picker is not a rule: the API is what stops a stale tab, a
     * scripted client or a retried request from planning work that cannot be planned.
     */
    if (item.archivedAt) {
      throw new PreconditionFailedException(
        'CAPACITY_ALLOCATION_ARCHIVED',
        'That Feature is archived',
      );
    }
    if (item.state === 'cancelled') {
      throw new PreconditionFailedException(
        'CAPACITY_ALLOCATION_CANCELLED',
        'A cancelled Feature is not planning demand',
      );
    }
    /**
     * "Release is Unscheduled or equals the Plan Release" — for the PLAN-LEVEL picker only.
     *
     * §225-233 give the two pickers different scopes on purpose. The Team-level `Add Features` has
     * "**no Release filter**", because "a planner needs to see the Project's whole Feature inventory
     * when staffing a Team", and §252 requires those allocations to render. The plan-level `Add
     * Feature` keeps the eligibility list, release included.
     *
     * The distinction the API can see is whether a TEAM is named: a team-level add and the Allocate
     * dialog both assign to a team, while the plan-level picker creates an unallocated row. So a
     * team-assigned allocation may cross releases and a parked one may not.
     *
     * What that used to protect is now protected where it belongs: `publishPlan` no longer writes this
     * plan's Release over a Feature that already belongs to another one — it skips and reports it. The
     * guard was standing in for a publish rule, which made §226 unimplementable.
     */
    if (!allowOtherRelease && item.releaseId !== null && item.releaseId !== plan.releaseId) {
      throw new PreconditionFailedException(
        'CAPACITY_ALLOCATION_OTHER_RELEASE',
        'That Feature belongs to another release; clear its Release or plan it there',
      );
    }
    return item;
  }

  /**
   * What a blank Estimate copies: the Feature's top-down estimate in the PLAN'S UNIT (§185).
   *
   * `defaultAllocationEstimate`, which is Refined → Preliminary and deliberately skips the allocated
   * tier — folding allocations back in would mean a blank field commits the sum of the very
   * allocations it is being used to create (§294). Until now that function had no production caller
   * at all: the rule lived in the read path's `resolveEstimate` and, separately, in the Allocate
   * dialog's own arithmetic.
   *
   * Zero is a legitimate answer, for a Feature with neither a Refined forecast nor a sized
   * Preliminary. It is stored as zero rather than refused, because "in the plan, not yet estimated"
   * is a real state — the row then carries `feature_missing_estimate`, which is the BA's report for it.
   */
  private async featureEstimate(
    actor: JwtPayload,
    plan: CapacityPlan,
    item: {
      preliminaryEstimate: PreliminaryEstimateSize;
      refinedEstimate: string;
      refinedItemCountEstimate: number;
    },
  ): Promise<number> {
    const map = await this.estimateMaps.forProject(plan.projectId);
    const size = map[item.preliminaryEstimate];
    return defaultAllocationEstimate(
      plan.unit === 'points'
        ? { refined: Number(item.refinedEstimate), preliminary: size.points }
        : { refined: item.refinedItemCountEstimate, preliminary: size.count },
    ).value;
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  /**
   * Load the plan and refuse if it is published, or if its PROJECT is archived.
   *
   * A published plan has written Release and planned dates onto Features, so editing it
   * in place would leave those writes describing a plan that no longer exists. Reverting
   * to draft is the supported route and arrives with the publish slice — until then
   * nothing can reach `published`, so this guard is proven by an e2e that inserts one
   * directly rather than by the UI.
   *
   * The archived-project check (PRJ-03 / PRJ-FR-010, "Archived Projects are read-only
   * regardless of access level") is HERE rather than repeated on eleven methods because
   * every plan write already funnels through this one load — so a write added later is
   * guarded by construction, which is the property that stopped holding when the rule was
   * a call-site convention. `ProjectsService.assertProjectWritable` is the only
   * implementation of it; nothing in this module re-states it.
   *
   * This module had NO archived-project check at all, and the worst consequence was
   * `publishPlan` → `applyPlanToFeature`: it wrote `releaseId`, `plannedStartDate` and
   * `plannedEndDate` onto an archived project's `portfolio_items` inside a transaction, so
   * archiving a project stopped nothing on the one path that mutates another aggregate's rows.
   *
   * `createPlan`, `deletePlan` and `revertPlan` do not come through here (they take no draft
   * precondition) and call the guard themselves. `forecastTeamCapacity` deliberately does not:
   * it computes a number and writes nothing, and a read is never guarded.
   */
  private async requireDraft(actor: JwtPayload, id: string): Promise<CapacityPlan> {
    const plan = await this.repo.findById(id, actor.workspaceId);
    if (!plan) throw new NotFoundException('CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found');
    await this.projects.assertProjectWritable(actor.workspaceId, plan.projectId);
    if (plan.status !== 'draft') {
      throw new PreconditionFailedException(
        'CAPACITY_PLAN_NOT_DRAFT',
        'A published plan is read-only; revert it to draft first',
      );
    }
    return plan;
  }

  private async requirePlanTeam(planId: string, teamId: string): Promise<CapacityPlanTeam> {
    const planTeam = await this.repo.findTeam(planId, teamId);
    if (!planTeam) {
      throw new NotFoundException('CAPACITY_TEAM_NOT_FOUND', 'That team is not on this plan');
    }
    return planTeam;
  }

  /**
   * The release must belong to the plan's project.
   *
   * `capacity_plans.release_id` carries no foreign key, and a release from another project
   * would make the plan describe a timebox outside its own scope — while still looking
   * correct, because the join would resolve a name.
   */
  private async assertReleaseInProject(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<void> {
    const rows = await this.db
      .select({ id: releases.id })
      .from(releases)
      .where(
        and(
          eq(releases.id, releaseId),
          eq(releases.workspaceId, workspaceId),
          eq(releases.projectId, projectId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new PreconditionFailedException(
        'CAPACITY_PLAN_RELEASE_MISMATCH',
        'Release not found in this project',
      );
    }
  }

  /**
   * A plan's team must be linked to the plan's PROJECT, not merely present in the workspace.
   *
   * This checked the workspace only, and the consequence was live: 11 `capacity_plan_teams` rows and
   * 12 allocations referenced teams with no link to their plan's project — including the seeded
   * `Team Beta`, which contributed demand to two plans while the Add/Remove Teams picker (which lists
   * `project_teams`) had no row for it, so it could not be removed through the UI at all.
   *
   * The BA states the source directly: "Teams are added through Project Breakdown."
   */
  private async assertTeamInProject(
    workspaceId: string,
    projectId: string,
    teamId: string,
  ): Promise<void> {
    const rows = await this.db
      .select({ id: teams.id })
      .from(teams)
      .innerJoin(projectTeams, eq(projectTeams.teamId, teams.id))
      .where(
        and(
          eq(teams.id, teamId),
          eq(teams.workspaceId, workspaceId),
          eq(projectTeams.projectId, projectId),
          /**
           * Both the LINK and the TEAM must be live.
           *
           * `project_teams` is a soft status flip, so an unlinked team keeps its row and this check
           * kept passing — an unlinked or archived team could still be added to a plan, which is
           * exactly the state migration 0085 was written to clean up ("11 `capacity_plan_teams` rows
           * and 12 allocations referenced teams with no link to their plan's project").
           * `applyProjectMove` in the portfolio service already required both; this is the same rule.
           */
          eq(projectTeams.status, 'active'),
          eq(teams.status, 'active'),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(
        'CAPACITY_TEAM_NOT_FOUND',
        "Team not found in this plan's project",
      );
    }
  }
}

/**
 * What a merged unassigned row carries when other rows fold into it.
 *
 * Every row now holds a real number (§11), so the value is simply their SUM — the demand those rows
 * represented together, which must not be discarded by a team removal or by a move to a plan that
 * does not hold the team.
 *
 * It used to be a three-case fold over nullable values, where `null` meant "charge the Feature's own
 * estimate" and therefore could not be added to. That case is gone with the nulls.
 *
 * The SOURCE survives only when exactly ONE row folds in: a single `feature_estimate` row moved
 * intact is still the Feature's estimate, but a sum of two rows is a number no single rule produced,
 * so calling it `feature_estimate` would claim the Feature is estimated at a figure it is not.
 */
export function mergeParked(
  rows: ReadonlyArray<{ value: string; source: CapacityAllocationSource }>,
): { value: string; source: CapacityAllocationSource } {
  const total = rows.reduce((sum, row) => sum + Number(row.value), 0);
  return {
    value: String(total),
    source: rows.length === 1 ? rows[0].source : 'manual',
  };
}

/** One Feature's publish decision, folded from however many allocation rows carry it. */
export interface PublishTarget {
  portfolioItemId: string;
  itemKey: string;
  /** The Feature's OWN Release — a Feature column, so identical on every row that names it. */
  releaseId: string | null;
  /** At least one allocation of this Feature names a team, so there is a plan to inherit. */
  hasTeam: boolean;
}

/**
 * The unique FEATURES a publish acts on, in first-appearance order.
 *
 * `P5-CP-035`: a Feature split across two teams has two allocation rows and exactly one publish
 * decision — the same window, the same Release answer, the same advisory. Iterating the rows wrote it
 * twice (harmless but for the `updated_at` churn) and REPORTED it twice, which is what the BA saw.
 *
 * `hasTeam` is an OR across the rows rather than a per-row test, because a Feature holding one team row
 * and one parked row is assigned: the old per-row loop updated it AND told the planner it had no team.
 */
export function publishTargets(
  rows: ReadonlyArray<{
    portfolioItemId: string;
    itemKey: string;
    itemReleaseId: string | null;
    teamId: string | null;
  }>,
): PublishTarget[] {
  const byFeature = new Map<string, PublishTarget>();
  for (const row of rows) {
    const seen = byFeature.get(row.portfolioItemId);
    if (seen === undefined) {
      byFeature.set(row.portfolioItemId, {
        portfolioItemId: row.portfolioItemId,
        itemKey: row.itemKey,
        releaseId: row.itemReleaseId,
        hasTeam: row.teamId !== null,
      });
      continue;
    }
    if (row.teamId !== null) seen.hasTeam = true;
  }
  return [...byFeature.values()];
}

/**
 * Length of a plan's window in whole days, both endpoints counted, or 0 when either date is
 * missing.
 *
 * Zero is what makes `forecastCapacity` report `no_window` instead of forecasting into a
 * window nobody defined — a plan with no dates is a real state, and inventing 90 days would
 * put a confident number on the screen for a question nobody asked.
 */
function windowDays(window: PlanWindow | null): number {
  if (window === null) return 0;
  const from = Date.parse(`${window.start}T00:00:00Z`);
  const to = Date.parse(`${window.end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000) + 1);
}

/**
 * The plan's window, or null when it does not have one — the ONE place that decision is made.
 *
 * A plan's two date columns are independently nullable, and "has a window" is not the same question
 * as "has a start date": every consumer needs both ends or neither. It had been re-decided in three
 * places with three different answers — the forecast treated a half window as no window, `windowsMatch`
 * treated it as unanswerable, and the publish writer treated it as a window whose ends were NULL and
 * stamped that onto Features. One resolver, returning a type that cannot hold a null end, is what
 * stops the third answer from existing.
 */
function planWindow(plan: {
  plannedStartDate: string | null;
  plannedEndDate: string | null;
}): PlanWindow | null {
  const { plannedStartDate: start, plannedEndDate: end } = plan;
  if (start === null || end === null) return null;
  return { start, end };
}

/**
 * A calendar DAY, whatever shape the value arrived in.
 *
 * Both sides of the comparison below come from Postgres `date` columns, so they are already
 * `YYYY-MM-DD`. This exists so the comparison cannot silently become a TIMESTAMP one: a seed, a raw
 * SQL write or a future `timestamptz` column would hand over `2026-08-07T00:00:00.000Z`, which is not
 * `=== '2026-08-07'` — and a plan that exactly matches its release would then report a mismatch, with
 * timezone as the invisible variable. Truncating at the `T` is enough because an ISO date-time always
 * begins with the date, and it never rewrites the day (no `Date` parsing, so no UTC shift).
 */
function dateOnly(value: string): string {
  return value.slice(0, 10);
}

/**
 * Does the plan's window MATCH the release's own window, EXACTLY?
 *
 * AC-019 is explicit, and says so three times (SRS §3.12, AC-019, `BUSINESS_FLOW:205`): the
 * Release field is written "only when the Plan planned start/end dates MATCH the selected Release
 * start/end dates". This used to test containment (`ps >= rs && pe <= re`), reasoning from
 * Broadcom's "do not span releases" wording — defensible for the agile ALM tool, but it is a deviation from the
 * BA's own acceptance criterion that no ruling covered, so a two-week plan inside a quarter-long
 * release wrote the Release field where the BA expects a reported skip. Ruled in favour of the BA.
 *
 * So EQUALITY, both ends, and never containment: `P5-CP-035` re-confirms it. The consequence to keep in
 * mind when reading the advisory copy — a plan that ENDS EARLIER than its release does not reach
 * outside it and still fails this check, so the message must say "does not exactly match" rather than
 * anything about spanning or overflowing.
 *
 * Unknown dates on either side mean the question cannot be answered, and an unanswerable check
 * must not authorise the write — a plan or release with no dates skips the Release field and says
 * so. The plan side of that is already decided by `planWindow`, which is why this takes a resolved
 * window: a `null` here is "the plan states no window", not "one end is missing".
 */
function windowsMatch(
  window: PlanWindow | null,
  release: { startDate: string | null; endDate: string | null } | null,
): boolean {
  if (window === null || release === null) return false;
  const { start: ps, end: pe } = window;
  const { startDate: rs, endDate: re } = release;
  if (rs === null || re === null) return false;
  // Date-only on both sides, then plain string equality: ISO `YYYY-MM-DD` compares correctly as a
  // string, so no parsing — and therefore no timezone — is involved.
  return dateOnly(ps) === dateOnly(rs) && dateOnly(pe) === dateOnly(re);
}

/**
 * Sum of the capacities teams have actually ENTERED, or null while none has.
 *
 * Null keeps `computeCutlineIndex` from drawing a line: with no stated ceiling there is nothing
 * for the running total to exceed, and a line at the top would claim nothing fits.
 */
function totalEnteredCapacity(teams: CapacityPlanTeamWithMetrics[]): number | null {
  let total: number | null = null;
  for (const team of teams) {
    const capacity = team.metrics.capacity;
    if (capacity === null) continue;
    total = (total ?? 0) + capacity;
  }
  return total;
}

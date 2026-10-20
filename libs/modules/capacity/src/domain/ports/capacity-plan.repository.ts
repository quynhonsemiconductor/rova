import type { DbExecutor } from '@platform';
import type { CapacityAllocationSource } from '../../../../../../db/schema/enums';
import type { VelocitySample } from '../capacity-forecast';
import type { CapacityAllocation, CapacityAllocationRow } from '../capacity-allocation.types';
import type {
  CapacityPlan,
  CapacityPlanTeam,
  CapacityPlanView,
  CreateCapacityPlanInput,
  PlanWindow,
  UpdateCapacityPlanInput,
} from '../capacity-plan.types';

export const CAPACITY_PLAN_REPOSITORY = Symbol('CAPACITY_PLAN_REPOSITORY');

export interface ICapacityPlanRepository {
  findById(id: string, workspaceId: string): Promise<CapacityPlan | null>;

  /**
   * The detail surface: plan + release/project names + every team, in ONE round trip.
   *
   * The grid shows a row per team with capacity alongside plan totals; fetching teams
   * per row would make a plan with ten teams eleven requests.
   */
  findViewById(id: string, workspaceId: string): Promise<CapacityPlanView | null>;

  /**
   * Plans for a project, newest first.
   *
   * Not paginated: a plan is per (project, release), so the count is bounded by the
   * project's releases — tens, not thousands. Adding a cursor here would be scaffolding
   * for a scale this table cannot reach.
   */
  listByProject(projectId: string, workspaceId: string): Promise<CapacityPlanView[]>;

  /** The existing plan for a (project, release) pair, for the uniqueness pre-check. */
  findByProjectRelease(
    projectId: string,
    releaseId: string,
    workspaceId: string,
  ): Promise<CapacityPlan | null>;

  /**
   * MAX(numeric suffix of `plan_key`) + 1 for a project.
   *
   * Not `count(*) + 1`: a deleted plan would make the count under-report and reissue a key a
   * surviving row still holds. Not atomic under concurrent creates either, which is why the
   * service retries once on the unique violation.
   */
  nextKeyNumber(projectId: string, workspaceId: string): Promise<number>;

  create(input: CreateCapacityPlanInput, executor?: DbExecutor): Promise<CapacityPlan>;

  /** Hard delete. Teams and allocations go with it via `ON DELETE CASCADE`. */
  delete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void>;

  update(
    id: string,
    input: UpdateCapacityPlanInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<CapacityPlan>;

  // ── Teams on a plan ────────────────────────────────────────────────────────

  findTeam(planId: string, teamId: string): Promise<CapacityPlanTeam | null>;

  addTeam(planId: string, teamId: string, executor?: DbExecutor): Promise<CapacityPlanTeam>;

  /** `capacity` may be null — "not entered", which is not the same as zero. */
  setTeamCapacity(
    planId: string,
    teamId: string,
    capacity: string | null,
    executor?: DbExecutor,
  ): Promise<CapacityPlanTeam>;

  removeTeam(planId: string, teamId: string, executor?: DbExecutor): Promise<void>;

  // ── Allocations ────────────────────────────────────────────────────────────

  /**
   * Every allocation on a plan with its per-row metrics, in ONE round trip.
   *
   * Returns rows rather than finished views: the tier needs the Preliminary Estimate
   * mapped through workspace settings, which is the service's job.
   */
  listAllocations(plan: CapacityPlan): Promise<CapacityAllocationRow[]>;

  findAllocation(id: string, planId: string): Promise<CapacityAllocation | null>;

  /**
   * Every allocation of ONE Feature on a plan, across teams and the Unallocated bucket.
   *
   * `listAllocations` would do it, but it runs the whole metrics query for every row on the plan to
   * answer a question about one Feature — `Move To Another Plan` needs the raw rows it is about to
   * relocate, not their computed tiers.
   */
  listAllocationsForItem(planId: string, portfolioItemId: string): Promise<CapacityAllocation[]>;

  /** An existing allocation for the same (plan, item, team) triple, for the merge check. */
  findAllocationFor(
    planId: string,
    portfolioItemId: string,
    teamId: string | null,
  ): Promise<CapacityAllocation | null>;

  createAllocation(
    input: {
      planId: string;
      portfolioItemId: string;
      teamId: string | null;
      /** The FIXED committed value (§11). Copied from the Feature or typed — `source` says which. */
      value: string;
      source: CapacityAllocationSource;
      isPrimary?: boolean;
    },
    executor?: DbExecutor,
  ): Promise<CapacityAllocation>;

  updateAllocation(
    id: string,
    input: {
      value?: string;
      /** Moves with `value`: a recopied estimate is `feature_estimate`, a typed one `manual`. */
      source?: CapacityAllocationSource;
      teamId?: string | null;
      isPrimary?: boolean;
    },
    executor?: DbExecutor,
  ): Promise<CapacityAllocation>;

  deleteAllocation(id: string, executor?: DbExecutor): Promise<void>;

  /** Does this Feature already have a primary team on this plan? */
  hasPrimaryAllocation(planId: string, portfolioItemId: string): Promise<boolean>;

  /** Clear the primary flag for one Feature — run before setting the new one, in one tx. */
  clearPrimaryAllocations(
    planId: string,
    portfolioItemId: string,
    executor?: DbExecutor,
  ): Promise<void>;

  /** The oldest team-assigned allocation, which inherits when the primary goes. */
  oldestTeamAllocation(
    planId: string,
    portfolioItemId: string,
    executor?: DbExecutor,
  ): Promise<{ id: string } | null>;

  /**
   * Allocations currently pointing at a team on this plan.
   *
   * Removing a team must not orphan its committed demand, so the service refuses while
   * this is non-zero. Allocations arrive in the next slice; the guard lives here now so
   * the rule cannot be forgotten once they do.
   */
  countTeamAllocations(planId: string, teamId: string): Promise<number>;

  /**
   * The rows one team holds on a plan — what `removeTeam` has to re-park.
   *
   * A count is not enough: each row has to be moved or merged individually, because at most ONE
   * unassigned row may exist per (plan, Feature) and some of these Features may already have one.
   */
  listAllocationsForTeam(planId: string, teamId: string): Promise<CapacityAllocation[]>;

  /**
   * Accepted totals per FINISHED iteration for one team — the sample set the capacity
   * forecast draws from.
   *
   * Attributed by the story's own team rather than the iteration's, and measured over
   * ACCEPTED states, not completed ones. See the implementation for why both matter.
   */
  /** The release's own window (`start_date` / `release_date`), for the span check. */
  releaseWindow(
    releaseId: string,
    workspaceId: string,
  ): Promise<{ startDate: string | null; endDate: string | null } | null>;

  /**
   * Write the plan's window — and optionally its release — onto one Feature.
   *
   * EVERY key here is "present means write it, absent means leave the column ALONE". `releaseId`
   * omitted is Rally's behaviour when the plan's window does not match its release's: the dates are
   * still written, only the Release field is skipped. `window` omitted is the same instruction about
   * the dates, and it is why neither field is nullable — publish used to pass the plan's own
   * `plannedStartDate` / `plannedEndDate` straight through, so publishing a plan with no window (the
   * default, since the New Plan dialog collects none per SRS §5) wrote NULL over the planned window
   * of every allocated Feature. A clear is now unrepresentable rather than merely unintended: there
   * is no value this method accepts that empties a Feature's window.
   *
   * Resolves TRUE when a row was written; false means the Feature is archived and matched nothing.
   */
  applyPlanToFeature(
    portfolioItemId: string,
    workspaceId: string,
    /** The PLAN's project — filtered on, so a publish can never write across projects. */
    projectId: string,
    fields: { window?: PlanWindow; releaseId?: string },
    executor?: DbExecutor,
  ): Promise<boolean>;

  /**
   * Point one Feature at a release, touching NOTHING else.
   *
   * `applyPlanToFeature` writes the planned dates alongside the release, which is right for a publish
   * and wrong for Rally's `Update the Release to match the selected plan` — that option moves the
   * Feature's release and leaves its dates to the target plan's own publish.
   */
  setFeatureRelease(
    portfolioItemId: string,
    workspaceId: string,
    releaseId: string,
    executor?: DbExecutor,
  ): Promise<void>;

  /** Flip a plan between draft and published, stamping `published_at`/`published_by`. */
  setStatus(
    id: string,
    workspaceId: string,
    status: 'draft' | 'published',
    publishedBy: string | null,
    executor?: DbExecutor,
  ): Promise<CapacityPlan>;

  teamVelocitySamples(
    projectId: string,
    teamId: string,
    workspaceId: string,
    historyDays: number,
  ): Promise<VelocitySample[]>;

  /**
   * Mean length of the project's dated iterations, in days, or null when it runs none.
   *
   * Only the supplied-velocity forecast needs this, and only when the team has no accepted
   * history to average: "so many points per iteration" cannot be spread over a window until
   * something says how long an iteration is. Every iteration counts here, not just finished
   * ones — the question is the project's CADENCE, which the current and planned iterations
   * describe as well as the past ones.
   */
  projectIterationCadenceDays(projectId: string, workspaceId: string): Promise<number | null>;
}

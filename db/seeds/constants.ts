import type { drizzle } from 'drizzle-orm/node-postgres';
import type * as schema from '../schema';

/**
 * Shared seed constants — fixed UUIDs, project fixtures, and helpers used across
 * the tiered seed modules (reference / bootstrap / demo).
 *
 * NOTE: this module must stay self-contained within `db/` — the migrator Docker
 * image compiles `db/**` only and does NOT include `libs/`, so nothing here may
 * import from `libs/` (see DEFAULT_WORKFLOW_STATUSES, inlined for that reason).
 */

/** Drizzle handle typed against the full seed schema. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

// Inlined from libs/modules/projects/src/domain/project.constants.ts
// so the migrator Docker image (which doesn't include libs/) can run this seed.
export const DEFAULT_WORKFLOW_STATUSES = [
  { name: 'Defined', category: 'to_do' as const, color: '#6B7280', position: 0, isDefault: true },
  {
    name: 'In Progress',
    category: 'in_progress' as const,
    color: '#3B82F6',
    position: 1,
    isDefault: false,
  },
  { name: 'Completed', category: 'done' as const, color: '#10B981', position: 2, isDefault: false },
  { name: 'Accepted', category: 'done' as const, color: '#059669', position: 3, isDefault: false },
] as const;

export function getDeterministicRank(itemKey: string): string {
  const match = itemKey.match(/\d+/);
  if (!match) return 'a0000';
  return 'a' + match[0].padStart(4, '0');
}

// Fixed UUIDs ensure idempotency — same rows on every seed run.
export const ADMIN_USER_ID = '00000000-0000-7000-8000-000000000002';
export const WORKSPACE_ID = '00000000-0000-7000-8000-000000000003';
export const DEVELOPER_ID = '00000000-0000-7000-8000-000000000020';
export const VIEWER_ID = '00000000-0000-7000-8000-000000000021';

// ── Single end-to-end demo flow (NXP only) ───────────────────────────────────
// Team Alpha (with members) → Story + Defect (team-linked) → 3 Tasks under the
// Story (team/iteration inherited) → Iteration (contains Story + Defect) →
// Release + Milestone (linked to each other and to the Story). Every FK below
// resolves to a real, matching row — see demo.ts `seedFlow()`.
export const NXP_STORY_1_ID = '00000000-0000-7000-8000-000000000030';
export const NXP_DEFECT_1_ID = '00000000-0000-7000-8000-000000000031';
export const NXP_TASK_1_ID = '00000000-0000-7000-8000-000000000032';
export const NXP_TASK_2_ID = '00000000-0000-7000-8000-000000000033';
// A THIRD task, owned by the admin, carrying logged Actuals. The other two cannot
// demonstrate the Team Status progress bar between them: TA-1 belongs to the
// developer, and TA-2 is deliberately "planned but not started" (Actuals 0). With
// only those, the admin — the principal every local session signs in as — has an
// estimate but nothing logged against it, so `actual / estimate` is a truthful 0%
// and the bar looks broken on a fresh database. See demo.ts.
export const NXP_TASK_3_ID = '00000000-0000-7000-8000-000000000034';

export const TEAM_ALPHA_ID = '00000000-0000-7000-8000-000000000040';

export const NXP_RELEASE_1_ID = '00000000-0000-7000-8000-000000000050';

export const NXP_ITER_CURRENT_ID = '00000000-0000-7000-8000-000000000061'; // committed ← active

export const NXP_MILESTONE_1_ID = '00000000-0000-7000-8000-0000000000b0';

// Portfolio fixture (P5): Epic → two Features, with the first Feature linked to
// the Story + Defect above so its rollup is non-empty and the second left empty so
// the "unmeasurable" rendering (em-dash, not 0%) has a case. Seeded because the
// Portfolio screen has no write paths yet, so E2E cannot create its own fixture.
export const NXP_EPIC_1_ID = '00000000-0000-7000-8000-0000000000c0';
export const NXP_FEATURE_1_ID = '00000000-0000-7000-8000-0000000000c1';
export const NXP_FEATURE_2_ID = '00000000-0000-7000-8000-0000000000c2';

// Capacity plan fixture (P5.2): one plan on the seeded release with Team Alpha added and
// capacity left NULL. Seeded because a release may hold only ONE plan
// (`uq_capacity_plan_project_release`), so a browser test that created its own would
// consume the project's only unplanned release and fail on the next run.
export const NXP_CAPACITY_PLAN_ID = '00000000-0000-7000-8000-0000000000d0';

/**
 * The rest of the Phase 5.2 flow fixture, added so the seeded plan walks the BA's whole
 * end-to-end flow rather than only its first two steps.
 *
 * Each id exists to make ONE state renderable that the thin fixture could not:
 *   • TEAM_BETA        a SECOND team, so a Feature can be split and the team grid can be sorted
 *   • FEATURE_3        split across both teams (primary + contributor), the `→ to` provenance case
 *   • FEATURE_4        parked in the Unallocated bucket — demand with nowhere to go
 *   • FEATURE_5        ARCHIVED, and FEATURE_6 CANCELLED: the two the picker and the API must refuse
 *   • FEATURE_7        committed to ANOTHER release, the third refusal
 *   • RELEASE_2        that other release, and the home of a PUBLISHED plan
 *   • CAPACITY_PLAN_2  published, so read-only rendering and Revert have a case without a test
 *                      having to publish the draft one first
 */
export const TEAM_BETA_ID = '00000000-0000-7000-8000-000000000041';
export const NXP_RELEASE_2_ID = '00000000-0000-7000-8000-000000000051';
export const NXP_FEATURE_3_ID = '00000000-0000-7000-8000-0000000000c3';
export const NXP_FEATURE_4_ID = '00000000-0000-7000-8000-0000000000c4';
export const NXP_FEATURE_5_ID = '00000000-0000-7000-8000-0000000000c5';
export const NXP_FEATURE_6_ID = '00000000-0000-7000-8000-0000000000c6';
export const NXP_FEATURE_7_ID = '00000000-0000-7000-8000-0000000000c7';
export const NXP_CAPACITY_PLAN_2_ID = '00000000-0000-7000-8000-0000000000d1';
export const NXP_STORY_2_ID = '00000000-0000-7000-8000-0000000000a2';
export const NXP_STORY_3_ID = '00000000-0000-7000-8000-0000000000a3';

// ── Seed data constants ───────────────────────────────────────────────────────
// Format: { id, key, name, description }
// All are owned by ADMIN_USER_ID and belong to the default workspace.
//
/**
 * EXACTLY TWO projects, and that is a decision rather than an accident.
 *
 * NXP carries the deep reference data — several iterations, two releases, an Epic with Features,
 * capacity plans in both states, frozen report history, SCM links, attachments, notifications.
 * PAY mirrors every entity TYPE with one row each, so anything that needs a *second* project
 * (isolation, permission scoping, cross-project refusals, "another release", All-Teams fusion) has
 * one waiting instead of building its own.
 *
 * That second project is the point: the BE e2e suite used to call `createProject` 84 times per run
 * and clean up none of it, which is how a dev database reached 1,900 portfolio items and pushed
 * `portfolio_items.rank` into its `varchar(255)` ceiling — after which every insert failed and the
 * suite could not run at all. Fixtures that already exist cannot leak.
 */
export const SEED_PROJECTS = [
  {
    id: '00000000-0000-7000-8000-000000000010',
    key: 'NXP',
    name: 'NX Platform',
    description: 'Core NX mono-repo platform upgrades and tooling improvements.',
  },
  {
    id: '00000000-0000-7000-8000-000000000011',
    key: 'PAY',
    name: 'Payments Platform',
    description: 'The SECOND project: one of every entity type, for cross-project rules.',
  },
] as const;

// ── PAY: one of every entity type ────────────────────────────────────────────
export const PAY_PROJECT_ID = '00000000-0000-7000-8000-000000000011';
export const TEAM_GAMMA_ID = '00000000-0000-7000-8000-000000000042';
export const PAY_RELEASE_ID = '00000000-0000-7000-8000-000000000052';
export const PAY_ITER_ID = '00000000-0000-7000-8000-000000000062';
export const PAY_MILESTONE_ID = '00000000-0000-7000-8000-0000000000b1';
export const PAY_EPIC_ID = '00000000-0000-7000-8000-0000000000c8';
export const PAY_FEATURE_ID = '00000000-0000-7000-8000-0000000000c9';
export const PAY_STORY_ID = '00000000-0000-7000-8000-0000000000a4';
export const PAY_DEFECT_ID = '00000000-0000-7000-8000-0000000000a5';
export const PAY_TASK_ID = '00000000-0000-7000-8000-000000000034';
export const PAY_CAPACITY_PLAN_ID = '00000000-0000-7000-8000-0000000000d2';

// ── NXP: the extra timeboxes the reports need ────────────────────────────────
/** FINISHED, so Velocity has a completed bar and the Burndown has closed history. */
export const NXP_ITER_PAST_ID = '00000000-0000-7000-8000-000000000063';
/** PLANNING and future — the backlog's "not yet scheduled" side. */
export const NXP_ITER_FUTURE_ID = '00000000-0000-7000-8000-000000000064';
/**
 * An ACCEPTED story inside the finished iteration.
 *
 * Velocity needs accepted points in a completed timebox to draw anything, and the Backlog has to show
 * an `accepted` iteration's NAME — a rule a Playwright spec used to create an iteration through the UI
 * on every run to test.
 */
export const NXP_ACCEPTED_STORY_ID = '00000000-0000-7000-8000-0000000000a6';

// ── Cross-cutting fixtures (one per empty table) ─────────────────────────────
export const SEED_FILE_ID = '00000000-0000-7000-8000-0000000000e0';
export const SEED_SCM_INSTALLATION_ID = '00000000-0000-7000-8000-0000000000e1';
export const SEED_SCM_REPOSITORY_ID = '00000000-0000-7000-8000-0000000000e2';

// ── Phase 7 (Test Case & Test Result) fixtures ───────────────────────────────
/**
 * NXP: two Test Cases under `NXP_STORY_1_ID` — one WITH Results (incl. a `fail`, so `Last
 * Verdict`/`Last Run` are populated and non-trivial), one with NONE (so the tab's `Not Run` /
 * `Not run yet` rendering has a case, BR10). PAY gets exactly one of each type, mirroring every
 * other PAY fixture's "one row per entity type" rule.
 */
export const NXP_TEST_CASE_1_ID = '00000000-0000-7000-8000-0000000000f2';
export const NXP_TEST_CASE_2_ID = '00000000-0000-7000-8000-0000000000f3';
export const NXP_TEST_RESULT_1_ID = '00000000-0000-7000-8000-0000000000f4';
export const NXP_TEST_RESULT_2_ID = '00000000-0000-7000-8000-0000000000f5';

export const PAY_TEST_CASE_ID = '00000000-0000-7000-8000-0000000000f6';
export const PAY_TEST_RESULT_ID = '00000000-0000-7000-8000-0000000000f7';

# Phase 5 — Portfolio Items + Capacity Planning: Architecture

**Author:** Solution Architecture
**Date:** 2026-07-29
**Status:** Proposal for review
**Inputs:** BA SRS `04_Developement_tracking/Phase 5/{01_Portfolio_Items,02_Capacity_Planning}/SRS.md`
(BA-closed 2026-07-28), verified against Rally's TechDocs.

---

## 1. TL;DR

- **Two aggregates, not four.** `PortfolioItem` (one table, `type ∈ {epic, feature}`)
  and `CapacityPlan` (plan + plan-team + allocation). Epic and Feature share a table
  because the SRS gives them one template, one list, one state enum and one create
  flow; splitting them would duplicate rank, rollups and RBAC for no behavioural gain.
- **Reuse, do not rebuild:** `lexorank.util`, `ACCEPTED_SCHEDULE_STATES` /
  `COMPLETED_SCHEDULE_STATES`, `DataTableFrame` + `useDataTable` + `ColumnSpec[]`,
  `DetailLayout` + `DetailTabBar` + `DetailField`, `ArtifactTable`, `PaginationFooter`,
  the `PolicyGuard` + `@RequirePermission` tier-safe decorator, and the tag-based
  query-invalidation registry. Nine existing primitives cover ~80% of Phase 5's UI.
- **Rollups are computed, never stored.** One SQL aggregate per surface, same shape as
  `iteration-status.drizzle-repository`. No denormalised `percentDone` column.
- **The one genuinely new backend concept** is the Capacity Plan's *fixed allocation*:
  a value frozen at planning time that must not drift when child estimates change.
  That is a real column, not a rollup.
- **Two SRS gaps to settle with the BA before build:** Rally's **cutline** and
  Feature **planned start/end + status colour**. Both are cheap now and expensive later.

---

## 2. What already exists that Phase 5 must reuse

Audited 2026-07-29. This is the reuse contract — a Phase 5 PR that reimplements any of
these should be rejected in review.

| Need | Existing thing | Where |
|---|---|---|
| Manual stack rank | `between(low, high)` LexoRank + `lockRankScope` advisory lock + `findMaxRank` | `libs/platform/src/utils/lexorank.util.ts`, `work-items.service.ts:333` |
| "Accepted" for Percent Done | `ACCEPTED_SCHEDULE_STATES` = `accepted, release` | `db/schema/enums.ts:316` |
| "Complete" for Capacity | `COMPLETED_SCHEDULE_STATES` = `completed, accepted, release` | `db/schema/enums.ts:309` |
| Aggregate-in-SQL rollup | `coalesce(sum(x) filter (where …), 0)` pattern | `iteration-status.drizzle-repository.ts:29-31` |
| List grid | `DataTableFrame` + `useDataTable` + `ColumnSpec[]` (resize, sort, show-fields) | `shared/ui/table`, `shared/ui/list-page` |
| Detail page chrome | `DetailLayout` + `DetailTabBar` + `DetailField` | `shared/ui/detail/` |
| Linked work-item sub-table | `ArtifactTable` | `entities/work-item/ui/artifact-table.tsx` |
| Paged list footer | `PaginationFooter` | `shared/ui/pagination-footer.tsx` |
| Per-project entity key | `nextKeyNumber(projectId, workspaceId)` | `release.drizzle-repository.ts:59` |
| Authorization | `PolicyGuard` + `@RequirePermission` (tier-safe overloads) | `libs/modules/access` |
| Cache invalidation | `meta.invalidates` tags + `MutationCache` | see `rally-cache-invalidation` |
| Module shape | `domain/` + `domain/ports/` + `application/` + `infrastructure/persistence/` + `interface/http/dto/` | `libs/modules/releases/src` |

### Two corrections to the ADR, from the audit

1. **`ADR-001` says catalogs live in `entities/<x>/model/`.** In practice all three
   existing catalogs live in `pages/<entity>/model/columns.ts`
   (`releases`, `iterations`, `iteration-status`), and `entities/` holds only
   `work-item`, `activity`, `audit`. **Follow the code, not the ADR** — Phase 5 uses
   `pages/portfolio/model/columns.ts`. Either amend the ADR or accept the drift
   knowingly; do not let Phase 5 be the fourth convention.

2. **`FieldSpec[]` and `ArtifactsTab` from ADR-001 §4 were never built.** `DetailLayout`,
   `DetailTabBar` and `DetailField` were. Phase 5 needs a Details tab + a Children tab
   on Feature — i.e. exactly the `ArtifactsTab` the ADR specified. **Build it once here**
   and retrofit Milestones/Releases, rather than copying their duplicated toolbars a
   third time. That is the cheapest moment this debt will ever be repayable.

---

## 3. Data model

### 3.1 `work.portfolio_items` — one table, two types

```
portfolio_items
  id                            uuid pk
  workspace_id                  uuid not null
  project_id                    uuid not null        -- Epic: project-level. Feature: owning project
  item_key                      varchar(30) not null -- 'EP-101' | 'FE-318'
  type                          portfolio_item_type not null   -- enum: epic | feature
  name                          varchar not null
  description                   text
  state                         portfolio_item_state not null default 'no_entry'
  preliminary_estimate          preliminary_estimate_size not null default 'no_entry'
  refined_estimate              numeric(6,2)          -- points forecast, nullable
  refined_item_count_estimate   integer               -- count forecast, nullable
  parent_id                     uuid                  -- Feature -> Epic. null for Epic
  team_id                       uuid                  -- Feature only; null for Epic
  release_id                    uuid                  -- Feature only; null for Epic
  owner_id                      uuid
  rank                          varchar(255) not null default ''
  archived_at                   timestamptz           -- archive, never hard delete
  created_at / updated_at       timestamptz
```

Indexes: `uq (workspace_id, item_key)`, `ix (workspace_id, project_id, rank)`,
`ix (parent_id, rank)`, `ix (workspace_id, type, archived_at)`.

**Why one table.** The SRS gives Epic and Feature the same list, the same 11-value
state, the same create template, the same rank column, the same archive semantics and
the same owner/project fields. The differences are three *nullable* columns
(`team_id`, `release_id`, `parent_id`) and which rollup formula applies. Two tables
would duplicate the rank scope logic, the key generator, the RBAC surface and the list
query, and would make the SRS's single `Type` selector a union query. Rally itself
models all portfolio item types in one collection with a `TypeDefinition` level — this
matches the reference product.

**Enforce the type rules in a CHECK, not just the service:**

```sql
constraint ck_portfolio_epic_shape check (
  type <> 'epic' or (team_id is null and release_id is null and parent_id is null)
)
constraint ck_portfolio_feature_parent check (
  type <> 'feature' or parent_id is null or parent_id <> id
)
```

Seed bypasses the service layer (see `rally-business-invariants`), so an invariant that
only lives in the service is not an invariant. This is the same lesson as
flow=schedule.

### 3.2 `work.work_items.feature_id`

```
alter table work.work_items add column feature_id uuid;
create index ix_wi_feature on work.work_items (feature_id);
```

Nullable. Points at a `portfolio_items` row of `type='feature'` — enforce in the
service and with a partial FK-ish check; Postgres cannot FK to a filtered subset, so
the service must assert type on write. Story/Defect only; Tasks never carry it.

### 3.3 Capacity Planning — three tables

```
capacity_plans
  id, workspace_id, project_id, release_id
  name
  status            capacity_plan_status not null default 'draft'   -- draft | published
  planned_start_date / planned_end_date  date
  published_at, published_by
  created_at / updated_at
  unique (project_id, release_id)          -- SRS §3.3: one plan per Project+Release

capacity_plan_teams
  id, plan_id, team_id
  capacity          numeric(8,2)            -- MANUAL, entered in the plan
  unique (plan_id, team_id)

capacity_plan_allocations
  id, plan_id, portfolio_item_id
  team_id           uuid                    -- NULL = Unallocated placeholder
  value             numeric(8,2) not null   -- FIXED at planning time
  created_at / updated_at
  index (plan_id, portfolio_item_id)
```

**`value` is the only number in Phase 5 that is stored rather than computed**, and the
SRS is explicit about why (§3.8): planning demand must stay fixed even if child
estimates move later. Do not "fix" it into a rollup.

`team_id` nullable is deliberate — it models the Unallocated bucket without a second
table, and §11's rule "`Total Allocated` counts only rows assigned to a Team" falls out
of `where team_id is not null`.

### 3.4 New enums

```ts
portfolioItemTypeEnum      = ['epic', 'feature']
portfolioItemStateEnum     = ['no_entry','intake','idea_prioritization','problem_discovery',
                              'solution_discovery','feature_prioritization','developing',
                              'accepted','measuring','done','cancelled']
preliminaryEstimateEnum    = ['no_entry','xs','s','m','l','xl']
capacityPlanStatusEnum     = ['draft','published']
```

`portfolio_item_state` deliberately does **not** reuse `workItemScheduleStateEnum`.
They are different lifecycles — Rally defines portfolio state per type at workspace
level. Conflating them is the mistake `enums.ts` D1/D2 already warns about.

---

## 4. The estimate mapping — do not hard-code

The SRS calls `XS=1, S=3, M=5, L=8, XL=13` **temporary mockup data** and defers the real
configuration to `Settings > Workspace > Project Management`. Rally makes this a
workspace-admin setting.

**Therefore: ship it as configuration from day one, even without the UI.**

```
workspace.workspace_settings   -- table already exists
  + preliminary_estimate_map  jsonb not null default
      '{"no_entry":{"points":0,"count":0},"xs":{"points":1,"count":1}, …}'
```

Reading it from settings with a seeded default costs one join now. Hard-coding it into a
service constant costs a data migration plus a behaviour change later, and the SRS
explicitly forbids treating the values as product rules. This is the single highest-value
architectural decision in Phase 5.

---

## 5. Rollups — computed, one query per surface

All four Portfolio indicators and all Capacity metrics are **derived**. No stored
percentages, matching how `iteration-status` already works.

```
-- Feature rollup (per feature id), one aggregate for the list AND the detail
select
  pi.id,
  coalesce(sum(wi.story_points), 0)                                          as rollup_points,
  count(wi.id)                                                              as rollup_count,
  coalesce(sum(wi.story_points) filter (where wi.schedule_state
            in (ACCEPTED_SCHEDULE_STATES)), 0)                              as accepted_points,
  count(wi.id) filter (where wi.schedule_state
            in (ACCEPTED_SCHEDULE_STATES))                                  as accepted_count
from portfolio_items pi
left join work_items wi on wi.feature_id = pi.id and wi.deleted_at is null
where pi.type = 'feature' and pi.id = any($1)
group by pi.id
```

- **Percent Done by Story Plan Estimate** = `accepted_points / rollup_points`
- **Percent Done by Story Count** = `accepted_count / rollup_count`
- **Estimated Progress by Points** = `accepted_points / coalesce(refined_estimate, map(preliminary).points)`
- **Estimated Progress by Count** = `accepted_count / coalesce(refined_item_count_estimate, map(preliminary).count)`

Epic rolls up **through** its Features — same query with
`wi.feature_id in (select id from portfolio_items where parent_id = $epic)`.

**Two different "done" definitions, and both already exist:**

| Surface | SRS wording | Constant |
|---|---|---|
| Portfolio Percent Done | "accepted linked Story/Defect" | `ACCEPTED_SCHEDULE_STATES` |
| Capacity `Complete` | "state IN [Completed, Accepted, Release]" | `COMPLETED_SCHEDULE_STATES` |

This is not an inconsistency in the SRS — it is the D1 distinction `enums.ts:287` already
documents. **Do not unify them.** A spec should assert they stay different.

### Estimate tier resolution (SRS §11) — one shared function

```ts
type EstimateTier = 'allocated' | 'refined' | 'preliminary' | 'none'

resolveFeatureEstimate(feature, plan?) -> { value, tier }
  1. plan && sum(allocation.value where team_id is not null) > 0  -> allocated
  2. refined_estimate > 0                                          -> refined
  3. map(preliminary_estimate)                                      -> preliminary
  4. 0                                                              -> none
```

Used by the Features tab, the cutline and the UI tier badge. The **Allocate dialog
default deliberately skips tier 1** (SRS §11) — expose that as a separate
`defaultAllocationEstimate()` so the anti-circularity rule is a named function, not a
comment. A spec must cover it; it is the subtlest rule in Phase 5.

---

## 6. Backend structure

Two new modules, following `libs/modules/releases` exactly.

```
libs/modules/portfolio/src/
  portfolio.module.ts
  domain/
    portfolio-item.types.ts          # PortfolioItem, PortfolioItemType, rollup DTOs
    portfolio-rollup.ts             # PURE: percent + estimate-tier maths, no IO
    ports/portfolio-item.repository.ts
  application/
    portfolio-items.service.ts
    portfolio-item-activity-diff.ts  # mirror release-activity-diff
  infrastructure/persistence/portfolio-item.drizzle-repository.ts
  interface/http/
    portfolio-items.controller.ts
    dto/portfolio-item-{request,response}.dto.ts

libs/modules/capacity-planning/src/
  domain/
    capacity-plan.types.ts
    capacity-math.ts                 # PURE: tiers, warnings, cutline
    ports/capacity-plan.repository.ts
  application/
    capacity-plans.service.ts
    capacity-publish.service.ts      # publish / publish-without-fields
  infrastructure/persistence/capacity-plan.drizzle-repository.ts
  interface/http/…
```

**`portfolio-rollup.ts` and `capacity-math.ts` are pure and separately unit-tested.**
Every percentage, the three warning rules and the tier chain are arithmetic over plain
inputs — they must not require a database to test. This is what makes the SRS's formula
table verifiable.

`capacity-planning` depends on `portfolio` (reads Features), never the reverse.

### API surface

```
GET    /v1/portfolio-items?type=epic|feature&projectId&teamId&search&cursor
POST   /v1/portfolio-items
GET    /v1/portfolio-items/:id
PATCH  /v1/portfolio-items/:id
POST   /v1/portfolio-items/:id/archive
POST   /v1/portfolio-items/:id/rank        { before?, after? }
GET    /v1/portfolio-items/:id/children    -> paged linked Story/Defect

GET    /v1/capacity-plans?projectId
POST   /v1/capacity-plans                  { projectId, releaseId, name, dates }
GET    /v1/capacity-plans/:id              -> plan + teams + allocations + metrics
PATCH  /v1/capacity-plans/:id
POST   /v1/capacity-plans/:id/teams        /  DELETE :teamId
PATCH  /v1/capacity-plans/:id/teams/:teamId   { capacity }
POST   /v1/capacity-plans/:id/allocations  { portfolioItemId, teamId|null, value }
PATCH  /v1/capacity-plans/:id/allocations/:allocId
DELETE /v1/capacity-plans/:id/allocations/:allocId
POST   /v1/capacity-plans/:id/forecast     { historicVelocity } -> proposed capacities
POST   /v1/capacity-plans/:id/publish      { updateFields: boolean }
POST   /v1/capacity-plans/:id/revert
```

`GET /capacity-plans/:id` returns the whole plan with metrics in **one** response. The
grid shows Complete/Rollup/Estimated/Capacity per team *and* per allocated feature; N+1
per-row fetches would make the page unusable.

### Permissions

Catalog today is `<entity>:<action>` (`release:create`, `milestone:edit`, …). The SRS
says `manageFeatures`; **translate it to the house convention**:

```
portfolio:view    portfolio:create    portfolio:edit    portfolio:archive
capacity:view     capacity:manage     capacity:publish
```

`capacity:publish` is separate on purpose — publishing writes back to Feature
`release_id` and planned dates, which is a different blast radius from editing a draft.

All are **workspace-tier** except where the SRS scopes by project; those routes take
`@RequirePermission('…', { from: 'query', field: 'projectId' })` per the tier-safe
overload. Add the codes to `db/permissions.catalog.ts` — `permissions.spec.ts` and
`fe-permission-contract.spec.ts` will fail until BE and FE agree, which is the point.

### Publish semantics (SRS §3.12) — the one risky write

```
publish(updateFields = true):
  assert status = 'draft'
  if plan.planned_start = release.start AND plan.planned_end = release.end:
      write feature.release_id for every allocated Feature
  else:
      skip the release write, return advisory in the response
  status -> 'published'
```

The date-mismatch branch must be a **returned advisory the UI shows**, not a silent
skip and not an exception. Model the result as
`{ published: true, featuresUpdated: n, skipped: [{featureId, reason}] }`. Revert to
draft does **not** roll back written fields — state that in the response too.

---

## 7. Frontend structure

```
pages/portfolio/
  model/columns.ts                 # ColumnSpec[] for Epic and Feature variants
  model/fields.ts                  # field catalog for detail + create modal
  portfolio-page.tsx               # DataTableFrame + useDataTable
  portfolio-detail-page.tsx        # DetailLayout + DetailTabBar (Details | Children)
  ui/portfolio-row.tsx             # ONE row component (ADR rule)
  ui/portfolio-child-preview.tsx   # the ≤5-child chevron preview
  ui/create-portfolio-item-modal.tsx

pages/capacity-planning/
  model/columns.ts
  capacity-plans-page.tsx
  capacity-plan-detail-page.tsx
  ui/team-row.tsx
  ui/allocated-feature-row.tsx
  ui/allocate-dialog.tsx
  ui/capacity-breakdown-overlay.tsx

features/portfolio/api.ts
features/capacity-planning/api.ts

shared/ui/detail/artifacts-tab.tsx  # NEW — the ADR-001 primitive never built.
                                    # Retrofit Milestones + Releases in the same PR.
shared/ui/progress/composite-bar.tsx # NEW — Complete/Rollup/Estimated vs Capacity,
                                    # with the warning triangle. Used by team rows,
                                    # feature rows and the plan summary.
```

Two new shared primitives only. `composite-bar` is genuinely new (nothing today draws
three values against a baseline); `artifacts-tab` is repaying ADR-001 debt.

The `Show Fields` control, column resize and sort all come free from `useDataTable` —
the SRS's "every column resizable and sortable" is already satisfied by the engine.

---

## 8. Sequencing

Each slice ships behind the existing permission gates and is independently deployable.

| # | Slice | Contents |
|---|---|---|
| 1 | Schema + enums | tables, enums, `work_items.feature_id`, CHECK constraints, `preliminary_estimate_map` on workspace settings, permission codes |
| 2 | Portfolio read | list + detail + rollups + `ArtifactsTab` (retrofit Milestones/Releases) |
| 3 | Portfolio write | create/edit/archive, rank reorder (reuse `between` + lock), Feature↔Story linking |
| 4 | Capacity skeleton | plan CRUD, add/remove team, manual capacity, `composite-bar` |
| 5 | Allocation | allocate/split/edit/remove, Unallocated bucket, tier resolution + badges |
| 6 | Warnings + forecast | three advisory rules, `Calculate Capacity Forecast`, Breakdown overlay |
| 7 | Publish | publish / publish-without-fields / revert, date-match advisory |

Slice 1 carries the two decisions that are expensive to reverse (one-table model,
configurable estimate map). Get those reviewed before slice 2.

---

## 9. Testing

- **Pure maths** — `portfolio-rollup.spec.ts`, `capacity-math.spec.ts`: every formula in
  SRS §6 and §11, both zero-denominator cases, the tier chain, the allocate-default
  anti-circularity rule, all three warning rules.
- **Invariants** — the two `ACCEPTED_*`/`COMPLETED_*` sets stay distinct; Epic rows
  never carry team/release/parent (assert the CHECK, not just the service);
  `unique(project_id, release_id)` on plans.
- **e2e** — one flow spec: create Epic → Feature → link Stories → verify rollups →
  create plan → add team + capacity → allocate + split → warning appears →
  publish with matching dates writes `release_id`, mismatched dates does not.
  Runs as `rally_app` like every other e2e, so a missing GRANT fails CI.
- **Coverage ratchet** — add the new files to `vitest.config.ts`; `coverage-include.spec.ts`
  fails otherwise.

---

## 10. Open questions for the BA

Three, in priority order. The first two are gaps against Rally that are cheap now.

1. **Cutline.** Rally's Capacity Plan Items tab draws a cutline: sort by rank ascending
   and a line marks where cumulative estimate exhausts capacity — above it fits, below
   it does not. The SRS references a "Capacity Cutline" in §11 but never defines the
   row/marker, and §14 excludes only the *Breakdown chart*. Every input already exists
   (rank + resolved estimate + team capacity). Dropped deliberately, or lost between
   drafts?

2. **Feature planned start/end + status colour.** Rally derives a blue/green/yellow/red
   health indicator from accepted rate against planned end date (≥20% behind → yellow,
   ≥40% → red). The SRS has the two Percent Done bars but no planned dates on
   Feature/Epic, so health cannot be computed. §2 states the goal as leadership
   visibility of larger outcomes — progress without health only delivers half of that.
   Add `planned_start_date` / `planned_end_date`, or accept progress-only?

3. **Preliminary Estimate mapping.** Confirmed above as configuration (§4). Confirming
   the BA agrees the *default* values may ship in workspace settings before the
   `Project Management` UI exists — the alternative is Phase 5 shipping with no usable
   estimate fallback at all.

Also worth noting, not blocking: the SRS labels Rally's `Initiative` level as **Epic**.
Rally has no "Epic" in its portfolio hierarchy (`Feature → Initiative → Theme`); Epic is
Jira vocabulary. The SRS says the relabel is deliberate. Keep the mapping visible in
code comments and API docs so a future ALM-alignment effort does not have to rediscover
it.

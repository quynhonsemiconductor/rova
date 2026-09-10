# Phase 7 — Test Case & Test Result: implementation plan

| Attribute | Value |
|---|---|
| Status | Planned — not started |
| Author | Solution Architect (with BA SRS + approved mockup) |
| Created | 2026-09-07 |
| Sources of truth | `Mini_Rally_pj/04_Developement_tracking/Phase 7 (After MVP)/Test Case/SRS.md`; mockup `03_Mockup Design/src/app/pages/WorkItemDetailPage.tsx`, `WorkspaceProjectsPanel.tsx`, `model.ts`; the User Story AC1–AC4 |
| Rally parity checked against | `techdocs.broadcom.com/.../testing/managing-tests/manage-test-cases/test-case-fields.html`, `.../test-case-results/test-case-result-fields.html` |

The User Story covers AC1–AC4 only (tab, list, empty state, open detail). The SRS covers eight
surfaces. **Decision: build the full SRS, phased.** Phase A is exactly the User Story; each later
phase is independently mergeable and its own PR.

---

## 0. Decisions taken before planning (do not re-litigate without a fresh ruling)

| # | Decision | Reason | Reversal cost |
|---|---|---|---|
| D1 | Full SRS, delivered in 7 phases (A–G). Phase A = the US. | AC3's `Add New` needs a destination, so Create + Detail must land soon after; Results and Type config are separable. | none — phases are additive |
| D2 | `test_cases.work_item_id` is **NULLABLE**; only work-item-scoped routes are exposed in Phase 7. | Rally's Test Case is a project artifact with an OPTIONAL Work Product. A future `Quality > Test Cases` standalone surface, or Test Folder / Test Set support, then needs **no migration**. Declared divergence: our UI has no standalone list yet. | one route + one page, no schema change |
| D3 | New **`test_case:*` and `test_result:*` permission namespaces**, with a backfill migration. | Quality reuses `work_item:*`, but that makes `work_item:edit` imply editing every Test Case. A later "QA writes tests, not stories" ruling needs the split anyway. CLAUDE.md: *"a new permission needs a backfill migration"*. | catalogue edit + migration |
| D4 | TC-/TR- keys minted **`MAX(existing)+1` + unique index + retry**, following Portfolio. | `workspace_item_counters.item_type` is the `work_item_type` enum, narrowed by 0072 to story/task/defect. `portfolio-item.repository.ts:111` states this exact trade-off; releases/iterations/milestones make it too. | a migration on the counter table |
| D5 | Tab order: `Details | Tasks | Test Cases | Connections | Revision History`. | AC1: "immediately after Tasks", literally. `Connections` (SCM) does not exist in the mockup and shifts right. | one array reorder |
| D6 | `last_verdict` / `last_run` / `last_result_id` are **denormalised columns on `test_cases`, maintained by a DB TRIGGER**. | `db/seeds/**` and raw SQL write these tables directly — the same reason `trg_sync_accepted_date`, `trg_task_iteration_from_parent` and `timebox_group_id` are triggers. Also makes `Last Verdict` / `Last Run` sortable on the grid without a lateral join per row. | drop trigger, add lateral join |
| D7 | Test Case team scope is **inherited from the parent Work Item**; no second team predicate on `test_cases`. | A Test Case is only reachable through its Work Item, so `requireReadable(workItem)` already applies `assertTeamInScope`. Adding a second predicate means keeping `IN (…)` vs `IN (…) OR IS NULL` in step in two places — a Project-backlog Test Case has `team_id = NULL`. | add `resolveTeamScope` to 3 queries (needed anyway if D2 is ever exposed) |
| D8 | Per-project Type catalog = new **`work.test_case_types` table modelled on `work.labels`**, soft-hidden on remove (`archived_at`); `test_cases.type` stores the **name as a text snapshot**. | SRS §3.4 / AC17: a removed Type must still render on historical Test Cases. A snapshot makes that true by construction, and `archived_at` distinguishes "removed" from "never existed". | none |

### Declared divergences to record in `docs/DIVERGENCE.md`

1. **No standalone Test Case surface** (D2). Rally has `Quality > Test Cases`, Test Folders and Test
   Sets. Our Phase 7 exposes Test Cases only through a Work Item. Schema is ready; UI is not built.
2. **No Test Folder, Test Set, Last Build, Tags, Color, Expedite fields.** Rally's Test Case carries
   all of them (`test-case-fields.html`). The SRS §6.3 field list is exhaustive and names none, and
   §1 says technical design not visible in the mockup is unspecified. Do not add them on sight.
3. **`Validation Input` is NOT required here.** Rally marks it required; the SRS §5 makes `Name` the
   only required create field and §5 says every content field "starts blank". Our Create modal
   therefore cannot require it.
4. **Rally's Test Case Result has a `Test Set` field**; we have none, because we have no Test Sets.
5. **Test Case Type is per-PROJECT and admin-editable** (SRS §3). Rally's is a workspace-level
   customisable dropdown. Per-project is the BA's model.

---

## 1. Architecture placement

New backend module, four layers, following the `libs/modules/*` shape:

```
libs/modules/test-cases/src/
  interface/http/
    test-cases.controller.ts          # Test Case routes + nested Result routes
    test-case-types.controller.ts     # per-project Type catalog (Phase G)
    dto/test-case-request.dto.ts
    dto/test-case-response.dto.ts
    dto/test-result-request.dto.ts
    dto/test-result-response.dto.ts
  application/
    test-cases.service.ts
    test-results.service.ts
    test-case-types.service.ts
  domain/
    test-case.types.ts
    ports/test-case.repository.ts
    ports/test-result.repository.ts
    ports/test-case-type.repository.ts
  infrastructure/persistence/
    test-case.drizzle-repository.ts
    test-result.drizzle-repository.ts
    test-case-type.drizzle-repository.ts
  test-cases.module.ts
  index.ts                            # barrel; deep-import if a barrel would close a cycle
```

Cross-module dependencies (import by ALIAS, never relative path):

- `@modules/access` — `AccessService.assertTeamInScope` reached indirectly; `PolicyGuard` +
  `@RequirePermission` on every route.
- `@modules/work-items` — one call to load + authorise the parent Work Item. **Watch for a cycle**:
  `work-items` will need to read a Test Case COUNT for the tab badge. Resolve by having
  `test-cases` expose a `countByWorkItem` port that `work-items` deep-imports, or (preferred) by
  serving the count from the Test Cases list route's own `pageInfo.total` and having the tab badge
  read that — see Phase A task A7.
- `@modules/activity` — `ActivityLogger` for Revision History.
- `@modules/attachments` — `AttachmentsService` + one new `UploadPolicy` descriptor per new owner.
- `@modules/projects` — `assignmentCandidates` for Owner / Assigned To / Tester feeds. **Do not
  build a new candidate rule.** CLAUDE.md: `ProjectsService.assignmentCandidates` is the ONE
  expression of assignment eligibility.

Frontend, Feature-Sliced Design:

```
apps/web/src/
  features/test-cases/
    api.ts                            # query-key factory + react-query hooks
    model/test-case-columns.ts        # ColumnSpec[] for the tab grid
    model/test-result-columns.ts
    ui/create-test-case-modal.tsx
    ui/add-test-result-modal.tsx
    ui/verdict-badge.tsx              # -> promote to shared/ui if a 2nd consumer appears
  pages/work-item/ui/test-cases-tab.tsx
  pages/test-case/test-case-detail-page.tsx
  pages/test-case/ui/{test-case-details-tab,results-tab,detail-sidebar}.tsx
  pages/test-result/test-result-detail-page.tsx
  pages/settings/ui/test-case-types-section.tsx   # Phase G
```

---

## 2. Data model

### 2.1 `work.test_case_types` (modelled on `work.labels`)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid not null | |
| `project_id` | uuid not null | per-PROJECT catalog (SRS §3.1) |
| `name` | varchar(60) not null | SRS §3.3 caps at 60 |
| `position` | integer not null default 0 | preserves the five defaults' order |
| `archived_at` | timestamptz | soft-hide; `NULL` = selectable |
| `created_at` / `updated_at` | timestamptz not null default now() | |

- `uniqueIndex('uq_test_case_types_name').on(projectId, lower(name))` — SRS §3.3 says duplicate
  check is case-insensitive, so the index must be too, or the service check and the constraint
  disagree.
- Index on `project_id`.
- The five defaults (Acceptance, Functional, Regression, Performance, Usability) are seeded **on
  project create** and backfilled for every existing project by the migration.

### 2.2 `work.test_cases`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid not null | |
| `project_id` | uuid not null | SRS §6.3 read-only, inherited from Work Product |
| `team_id` | uuid | nullable = "Project backlog" (SRS §5); inherited, read-only |
| `work_item_id` | uuid | **NULLABLE** (D2). FK → `work.work_items(id)` `ON DELETE cascade`? **No** — see 2.5 |
| `test_case_key` | varchar(30) not null | `TC-<n>`, workspace-unique |
| `name` | varchar(500) not null | required |
| `description` / `objective` / `preconditions` / `validation_input` / `validation_expected_result` / `postconditions` / `notes` | text | rich-text bodies, all optional, all blank on create |
| `type` | varchar(60) not null | **text snapshot** of the Type name (D8) |
| `method` | `test_case_method` enum not null default `manual` | `manual` \| `automated` |
| `priority` | `test_case_priority` enum not null default `normal` | `low` \| `normal` \| `high` \| `urgent` |
| `owner_id` | uuid | SRS §6.3 editable, Project members |
| `assignee_id` | uuid | "Assigned To"; `NULL` renders `Unassigned` |
| `rank` | varchar(255) not null | LexoRank, same shape as work items |
| `last_verdict` | `test_verdict` enum | **maintained by trigger**; `NULL` renders `Not Run` |
| `last_run` | date | **maintained by trigger**; `NULL` renders `Not run yet` |
| `last_result_id` | uuid | **maintained by trigger**; which Result the two above came from |
| `created_by` | uuid not null | |
| `created_at` / `updated_at` | timestamptz not null | |
| `deleted_at` | timestamptz | soft delete, like `work_items` |

- `uniqueIndex('uq_test_case_key').on(workspaceId, testCaseKey)` — this is what actually protects
  the `MAX+1` mint (D4). The service retries **once** on conflict, as Portfolio does.
- Indexes: `(work_item_id)` filtered `deleted_at IS NULL`; `(project_id)`; `(workspace_id)`;
  `(work_item_id, rank)` for the tab's ordered read.
- **No FK on `owner_id` / `assignee_id`**, matching `work.tasks.assignee_id`: eligibility depends on
  project AND team, which no constraint expresses, and a user delete must not cascade into test
  history.

### 2.3 `work.test_results`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` / `project_id` | uuid not null | |
| `test_case_id` | uuid not null | FK → `test_cases(id)` `ON DELETE cascade` |
| `work_item_id` | uuid | SNAPSHOT of the Test Case's Work Product at result time — Rally: "the work product to which the test case result was associated **when you entered** the result", not editable |
| `test_result_key` | varchar(30) not null | `TR-<n>`, workspace-unique, `uq_test_result_key` |
| `build` | varchar(255) not null | required |
| `run_date` | date not null | required; named `run_date` not `date` (reserved-word hygiene) |
| `verdict` | `test_verdict` enum not null | `pass` \| `fail` \| `blocked` \| `error` \| `inconclusive` — **`not_run` is NOT valid here** |
| `duration_minutes` | integer not null default 0 | CHECK `>= 0` (SRS §8) |
| `tester_id` | uuid not null | required (SRS §8: Save disabled without it) |
| `notes` | text | |
| `created_by` | uuid not null | |
| `created_at` / `updated_at` | timestamptz not null | |
| `deleted_at` | timestamptz | |

- Index `(test_case_id, run_date desc, created_at desc)` — this IS the SRS §7 ordering and the
  trigger's own lookup, so one index serves both.
- `test_verdict` enum includes `not_run` **only for `test_cases.last_verdict`**. A result can never
  be `not_run`. Enforced by a CHECK on `test_results.verdict`, because one enum used two ways with
  one member excluded is exactly the sort of thing a later writer gets wrong.

### 2.4 Trigger: `trg_test_case_last_result` (D6)

`AFTER INSERT OR UPDATE OR DELETE ON work.test_results FOR EACH ROW`, recompute the owning Test
Case's three columns from:

```sql
select id, verdict, run_date
from work.test_results
where test_case_id = <tc> and deleted_at is null
order by run_date desc, created_at desc
limit 1
```

Sets all three to `NULL` when no live result remains. Must fire on UPDATE of `run_date`, `verdict`
and `deleted_at` (a soft delete is an UPDATE), and on a `test_case_id` change it must recompute
**both** the old and the new Test Case — the same both-sides rule iteration auto-accept needed.

**Pinned by** `test/e2e/derived-invariants.e2e.spec.ts` (extend the existing file): assert the
STORED columns, not the response of the call that changed the result.

### 2.5 Deletion semantics

- `work_item_id` carries **no** `ON DELETE cascade`, because a Work Item delete is SOFT
  (`deleted_at`) and a cascade would never fire anyway — the same reason CLAUDE.md records for
  `work.tasks`. Deleting a Story therefore leaves its Test Cases addressable but unreachable through
  the tab. **Phase F** decides the rule: either soft-delete the Test Cases in the same transaction
  (mirroring `P3-QA-FR-020`'s "child Tasks are retained" reasoning inverted) or leave them for the
  future standalone surface. **Put this to the BA** — see §7 Open questions.
- `test_results` → `test_cases` IS a real cascade, because a Result has no meaning without its Test
  Case and both are hard-FK'd within one module.

### 2.6 Enum additions to `entity_ref_type`

`test_case` and `test_result` must join `entityRefTypeEnum` (`db/schema/enums.ts:150`) for
attachments. **That enum is shared by `comments`, `attachments` AND `milestone_artifacts`** — adding
a member widens the vocabulary of all three. Mitigation, and it is not optional:

- Attachments: add one `UploadPolicy` descriptor per new owner (`attachment-policy.ts`), so the new
  owners are deliberately admitted.
- Comments: `CollaborationService` must **refuse** `test_case` / `test_result` until the BA asks for
  comments there — the SRS names no comment thread on either. Assert the refusal in a spec, or the
  widened enum silently becomes a feature nobody designed.
- `milestone_artifacts`: the milestone artifact writer already validates its entity kinds; add a
  negative case for the two new members.

`activityEntityTypeEnum` (`enums.ts:129`) also gains `test_case` and `test_result` — that one is
activity-only and has no such spillover.

---

## 3. API surface

All routes are project-tier and carry `@RequirePermission` with a scope. **A route with no
`@RequirePermission` is OPEN**, and `test/route-policy.ratchet.spec.ts` counts undecorated handlers.

### Test Cases (under Work Item)

| method | path | permission | scope | notes |
|---|---|---|---|---|
| `GET` | `/work-items/:id/test-cases` | `test_case:view` | `{ resource: 'work_item', from: 'param', field: 'id' }` | AC2. Returns `{ data, pageInfo }`; `pageInfo.total` feeds the tab badge (A7) |
| `POST` | `/work-items/:id/test-cases` | `test_case:create` | same | SRS §5 |

### Test Cases (record routes)

| method | path | permission | scope | notes |
|---|---|---|---|---|
| `GET` | `/test-cases/:id` | `test_case:view` | `{ resource: 'test_case', from: 'param', field: 'id' }` | AC4 |
| `GET` | `/test-cases/by-key/:key` | **none** | resolve-then-check in service | Keys are workspace-unique so the project is unknown until the row loads — the same shape as `GET /work-items/by-key`. **Declare `@AuthorizedInService`** and assert both directions in an e2e |
| `PATCH` | `/test-cases/:id` | `test_case:edit` | `{ resource: 'test_case', … }` | SRS §6.3 |
| `DELETE` | `/test-cases/:id` | `test_case:delete` | same | Phase F |
| `PATCH` | `/work-items/:id/test-cases/reorder` | `test_case:edit` | `{ resource: 'work_item', … }` | rank drag; authorise EVERY row, all-or-nothing (`loadBulkItems` shape) |

### Test Results

| method | path | permission | scope |
|---|---|---|---|
| `GET` | `/test-cases/:id/test-results` | `test_result:view` | `{ resource: 'test_case', from: 'param', field: 'id' }` |
| `POST` | `/test-cases/:id/test-results` | `test_result:create` | same |
| `GET` | `/test-results/:id` | `test_result:view` | `{ resource: 'test_result', from: 'param', field: 'id' }` |
| `PATCH` | `/test-results/:id` | `test_result:edit` | same |
| `DELETE` | `/test-results/:id` | `test_result:delete` | same |

### Type catalog (Phase G)

| method | path | permission | scope | notes |
|---|---|---|---|---|
| `GET` | `/projects/:id/test-case-types` | `test_case:view` | `{ from: 'param', field: 'id' }` — **no `resource`**, the param IS the project id | reference feed for the Create modal + Detail Type select |
| `POST` | `/projects/:id/test-case-types` | `workspace:edit` | same | SRS §3.3: Workspace Admin only. `workspace:edit` is WA-only, matching how the structural project routes are gated |
| `DELETE` | `/projects/:id/test-case-types/:typeId` | `workspace:edit` | same | soft-hide (`archived_at`) |

### `ProjectScopeResolver` additions

Two new `ScopedResource` kinds, `test_case` and `test_result`, each resolving `project_id` from its
own table. **Do not** reuse `work_item`: CLAUDE.md records that `work_item` already spans two tables
because routes were shared, and that the fix for a *distinct* row was a distinct kind. Test Case
routes are not shared with anything.

### Contract / codegen discipline

Every DTO change needs `pnpm --filter rally-web codegen` against a **restarted** local API, then a
commit. `/api/docs-json` serves a document built once at bootstrap — a watch-mode recompile is not
the same thing. **Grep the served spec for a new field name before trusting the generated client**:

```bash
curl -s localhost:3000/api/docs-json | grep lastVerdict
```

Expect a large diff when the module graph changes (`openapi-typescript` emits in module init order):
compare route INVENTORIES, not line counts.

---

## 4. Permissions (D3)

Add to `db/permissions.catalog.ts`:

```
TEST_CASE_VIEW: 'test_case:view'      TEST_RESULT_VIEW:   'test_result:view'
TEST_CASE_CREATE: 'test_case:create'  TEST_RESULT_CREATE: 'test_result:create'
TEST_CASE_EDIT: 'test_case:edit'      TEST_RESULT_EDIT:   'test_result:edit'
TEST_CASE_DELETE: 'test_case:delete'  TEST_RESULT_DELETE: 'test_result:delete'
```

- `PERMISSION_TIER`: all eight are **project-tier**.
- `ROLE_PERMISSIONS`: `workspace_admin` (via `workspace:*`), `project_admin` → all eight,
  `project_member` (Editor) → all eight **except** `test_case:delete`? — **No.** §3.2 gives an
  Editor Create/View/Edit/Delete on the Story, Defect and Task they own; a Test Case is the same
  class of delivery artifact and the SRS gives the tab no role restriction. Grant all eight to
  Editor. Recorded here so the next reader knows it was a choice, not an omission.
- `ACCESS_LEVEL_PERMISSIONS` follows automatically (`admin` = PROJECT_ADMIN's array,
  `editor` = PROJECT_MEMBER's).
- **Backfill migration is mandatory.** `db/seeds/bootstrap.ts` upserts tier roles with
  `set: { name }`, so a catalogue entry alone never reaches an existing workspace — exactly how
  `report:view` 403'd everyone but Workspace Admin until migration 0092. These codes are genuinely
  new (nobody can have revoked what never existed), so the backfill may **force** the array rather
  than merge.
- `permissions.spec.ts` and `fe-permission-contract.spec.ts` keep BE and FE from drifting; the FE
  mirror in `apps/web/src/shared/lib/access-levels.ts` (or its permission constant file) must move
  in the same commit.

---

## 5. Business rules to enforce (each one is a test)

| # | Rule | Where | Source |
|---|---|---|---|
| BR1 | `Name` required; every content field blank on create | `CreateTestCaseSchema` + service | SRS §5 |
| BR2 | `Type` defaults to the project's **first selectable** Type; a Test Case keeps its historical value even after that Type is removed | service (create) + type snapshot column | SRS §5, §6.3, AC17 |
| BR3 | `Method` defaults `manual`; `Priority` defaults `normal` | schema defaults | SRS §5 |
| BR4 | `Owner` defaults to the **current user when the feed offers them**, else Unassigned | reuse `useDefaultOwner` on FE + `assertAssignable` on BE | SRS §5 + `WIC-FR-006`; the eligibility gate is what makes the default safe |
| BR5 | `Project` and `Team` are **inherited and read-only**; a Work Item with no team displays `Project backlog` | service refuses `projectId`/`teamId` in the PATCH schema (do not advertise what is refused); FE renders `ReadOnlyFieldValue` | SRS §5, §6.3, AC6 |
| BR6 | `Assigned To` starts `Unassigned` | schema nullable | SRS §5 |
| BR7 | New Test Case ranks **after** the existing Test Cases of the same Work Item | `lockRankScope` + `findMaxRank` + `between()`, in that order and with the SAME executor | SRS §5; the advisory lock is why Portfolio does not hit `LEXORANK_NEIGHBOURS_OUT_OF_ORDER` |
| BR8 | Owner / Assigned To / Tester options are **project members** — one rule | `ProjectsService.assignmentCandidates` for the OFFER; the row's own joined name for DISPLAY | SRS §5, §6.3, §8, AC5; CLAUDE.md "A NAME belongs to the ROW; a picker feed can never be its source" |
| BR9 | `Last Verdict` / `Last Run` are read-only and always reflect the latest Result (date, then createdAt) | trigger (D6) | SRS §10, AC13 |
| BR10 | A Test Case with no Result shows `Not Run` / `Not run yet` — **never `--`, never `0`** | FE render | SRS §10. Note this is the second declared exception to `EMPTY_VALUE`, alongside Capacity's `Dependencies` `0` |
| BR11 | Result `Build`, `run_date`, `tester_id` required; `duration_minutes >= 0` | zod + CHECK | SRS §8, AC9 |
| BR12 | Adding a Result never replaces earlier Results | append-only insert | SRS §8, AC10 |
| BR13 | Result `Test Case` and `Work Product` are read-only; `work_item_id` is a snapshot taken at create | PATCH schema omits both | SRS §9.3, AC12; Rally's own wording |
| BR14 | Results list ordered `run_date desc, created_at desc` | repository | SRS §7, AC8 |
| BR15 | **No separate Test Steps list** anywhere | absence, asserted by an FE test | SRS §1, AC7 |
| BR16 | Type name: required, trimmed, ≤60 chars, case-insensitively unique per project | service + `uq_test_case_types_name` on `lower(name)` | SRS §3.3, AC15 |
| BR17 | Removing a Type takes it out of the SELECTABLE list only | `archived_at`; the Detail Type select unions the row's current value with the live list | SRS §3.4, AC17 |
| BR18 | Every new project starts with the five default Types | project-create hook + backfill migration | SRS §3.2, AC14 |
| BR19 | A Test Case is readable exactly when its parent Work Item is | `requireReadable(workItem)` before any Test Case read (D7) | Editor team-scope ruling: *"lists, reports, search, pickers and direct URLs"* |
| BR20 | Every sub-resource of a Test Case (results, activity, attachments, both attachment-download routes) goes through the SAME scoped read | one `requireReadable` path in the service | CLAUDE.md: the work-item sub-resource leak, incl. the signed-URL pair |

---

## 6. Phases

Mark each item `[x]` **immediately** on completion. A phase is done only when its own gate passes.

### Phase A — Read path: the User Story (AC1–AC4)

Delivers: the tab with its count, the list in the approved column order, the empty state, and
Test Case Detail opening from the ID. Create is stubbed to the Phase B modal — **`Add New` renders
in Phase A but is disabled with a tooltip**, so AC3's "the Add New action is displayed" is satisfied
without shipping a dead control.

- [x] **A1** Migration `0129_test_cases.sql`: `test_case_method`, `test_case_priority`,
  `test_verdict` enums; `work.test_case_types`, `work.test_cases`, `work.test_results` tables; all
  indexes; the `trg_test_case_last_result` trigger; `entity_ref_type` + `activity_entity_type` enum
  members; the five default Types backfilled for every existing project. **Hand-written** — mirror
  it into `db/schema/{work,enums}.ts` in the same commit. **One migration at a time**: verify
  `select count(*) from drizzle.__drizzle_migrations` equals the journal's entry count afterwards.
  Verified: 131 = 131 against `_journal.json`; ran against live DB, backfill hit both NXP and PAY
  (5 types each), trigger + both CHECK constraints confirmed via `\d`, enum widenings confirmed via
  `enum_range`.
- [x] **A2** `db/permissions.catalog.ts`: the eight codes, `PERMISSION_TIER`, `ROLE_PERMISSIONS`.
  Migration `0130_test_case_permissions.sql` force-backfills the three tier roles in every
  workspace. FE mirror updated in the same commit.
  Verified: 132 = 132 against journal; `permissions.spec.ts` + `fe-permission-contract.spec.ts`
  green (392 tests); live DB confirms workspace-scoped `project_admin`/`project_member` rows
  backfilled with all eight codes (global templates self-heal via `reference.ts`, no migration
  needed there).
- [x] **A3** `libs/modules/test-cases`: domain types, `ITestCaseRepository` (`listByWorkItem`,
  `findById`, `findByKey`, `countByWorkItem`), Drizzle repo with `ownerNameJoins`-style name joins
  for Owner and Assigned To. **`scope` is a REQUIRED parameter** on every read port, so a future
  call site that forgets the boundary is a compile error.
  Refinement confirmed with user: `scope` (`TeamReadScope`) is required-but-unused on the two
  LIST-shaped reads (`listByWorkItem`, `countByWorkItem`) as a structural guard only — D7 says no
  second team predicate, the real check is `requireReadable` on the parent. `findById`/`findByKey`
  carry NO scope param, matching `IWorkItemRepository.findById` — a single-row lookup is checked by
  the caller immediately after loading, so there's no list to leak from.
- [x] **A4** `TestCasesService`: `list`, `getById`, `getByKey`. Every path calls
  `requireReadable(workItem)` first (BR19). Implemented as a call into
  `WorkItemsService.getWorkItemForView` (asserts `work_item:view` + team scope) — no duplicate
  authorization logic in this module.
- [x] **A5** `ProjectScopeResolver`: `test_case` and `test_result` kinds. Added `TEST_CASE_NOT_FOUND`
  / `TEST_RESULT_NOT_FOUND` to `libs/platform/src/errors/error-codes.ts` (required — `ErrorCode` is
  a fixed union). `tsc -b --force` green across the whole repo after this and A3/A4.

  **Side effect surfaced and fixed**: widening `entity_ref_type` (A1) broke 3 files that had
  hand-typed narrow local unions assuming only 2 enum members (`attachments` module's
  `EntityAttachment[]`/`EntityAttachment | null` returns, and `collaboration` module's
  `toCommentDto` call sites in both controllers). Fixed with narrowing casts + comments (confirmed
  with user rather than pulling Phase C's C7 refusal-logic forward) — each site's query already
  guarantees only `work_item`/`portfolio_item` rows can appear, so the cast narrows to what's
  provably true, not to what the module newly accepts.
- [x] **A6** Controller: `GET /work-items/:id/test-cases`, `GET /test-cases/:id`,
  `GET /test-cases/by-key/:key`. DTOs as zod schemas; **response timestamps are
  `z.string().datetime()`, never `z.date()`** — `nestjs-zod` throws "Date cannot be represented in
  JSON Schema" when the OpenAPI factory runs and takes down every suite that boots through
  `bootstrapApp`.
  Split into TWO controllers (`WorkItemTestCasesController` under `work-items/:id/test-cases`,
  `TestCaseRecordsController` under `test-cases`) — one `@Controller()` base path each, mirroring
  how `collaboration` module splits `CollaborationController`/`PortfolioCollaborationController`
  rather than mixing two path families in one class. `TestCasesModule` registered in
  `apps/api/src/app.module.ts` (worker gets none — no cron/relay work in Phase A).
  Verified live: booted the built API, `TestCasesModule dependencies initialized` with no DI cycle,
  `Route authorization audit passed — 231 handlers, all declared`, all three routes mapped
  (`by-key/:key` correctly precedes `:id`), curled unauthenticated → 401 on all three (guard active).
- [x] **A7** Tab badge count. Implemented BOTH per the plan's own fallback clause: `pageInfo.total`
  from the list route (option a, preferred) AND a `countByWorkItem` repo method (option b, in case
  a later phase needs the badge to render before the tab opens) — no cross-module dependency added
  in either case since `test-cases` doesn't need `work-items` to read its own count.
- [x] **A8** `pnpm --filter rally-web codegen` against a restarted API — **note: the actual package
  name is `rova-web`**, not `rally-web` (CLAUDE.md is stale post product-rename; `--filter rally-web`
  fails with "No projects matched"). Grepped the served spec for `lastVerdict`/`testCaseKey` before
  trusting the client — both present, confirmed NOT stale. Diff is purely additive (236 insertions,
  0 deletions, no reordering) since no existing module's init order changed.
- [x] **A9** `features/test-cases/api.ts`: `testCaseKeys` factory, `useTestCases(workItemId)`,
  `useTestCase(id)`, `useTestCaseByKey(key)`. Use `listResource()` for the list so loading and
  error states are distinguishable — **`isError` must be read**; `data` is `undefined` both in
  flight and after failure.
- [x] **A10** `model/test-case-columns.tsx` (`.tsx`, not `.ts` — it holds inline JSX cells, matching
  `quality-parts.tsx`'s own file extension, not a bare `.ts` metadata-only file): `ColumnSpec[]` =
  Select, Rank, ID, Name, Type, Method, Priority, Owner, Last Verdict, Last Run (AC2 order,
  exactly). Rank via the shared `rankColumn()`. Widths fit the HEADER. Name is fixed-width with
  `break-words`, not `grow`.
- [x] **A11** `pages/work-item/ui/test-cases-tab.tsx` on `DataTableFrame`. `OwnerCell` for Owner (no
  `truncate` — one person per row, wraps). `VerdictBadge` + `TEST_VERDICT_STYLE` (split into its own
  `status-colors.ts`, matching `TEAM_STATUS_STYLE`'s file — a component file exporting a const
  alongside a component fails the FE's fast-refresh lint rule). Empty state + disabled `Add New`
  with a `title` tooltip (AC3). ID cell (`TestCaseIdCell`, NOT the shared `IdCell` — that couples to
  `WorkItemType` for its glyph, which a Test Case has none of) built on `<Button variant="link">`,
  not a raw `<button>` — the FE consistency ratchet counts those and would have risen.
- [x] **A12** Tab registration in `work-item-detail-page.tsx`, inserted between Tasks and
  Connections. **Confirmed with user**: D5's premise that Connections "does not exist in the
  mockup" is stale — Connections already exists today (own docblock: "appears in NO BA document…
  nobody has ruled on it") — kept D5's literal order regardless, since AC1 only requires "immediately
  after Tasks". Badge from A7 (the list query's own row count), hidden for `type === 'task'`.
- [x] **A13** Route `/test-case/$testCaseKey` in `app/router/router.tsx`. Plain `lazyPage`, NOT
  `guardedPage` — confirmed via `route-permission.contract.test.tsx` (new assertion added): unlike
  `/item/$itemKey`, there is no nav row or list surface to fold a permission code onto, so the PAGE
  owns 100% of its denied state (403/404/other) via `ApiError`, never `new Error(apiErrorMessage(...))`.
- [x] **A14** `pages/test-case/test-case-detail-page.tsx`, read-only. **Scope resolved with user**:
  ships `Details` tab ONLY — `Results (count)` and `Revision History` are OMITTED, not built as
  placeholders, because neither has a Phase A backend route (Results is Phase D; Test Case activity
  logging is Phase C) and a tab with nothing behind it is the premature-affordance problem `Add New`'s
  disabled-with-tooltip treatment exists to avoid. Uses the real `DetailReadonlyValue` component
  (plan named it `ReadOnlyFieldValue`, which does not exist — confirmed and used the actual name).
  Denied-state extracted to `model/unavailable-reason.ts` + `ui/test-case-unavailable.tsx`, same
  shape as `/item/$itemKey`'s `WorkItemUnavailable`.
- [x] **A15** i18n: `apps/web/src/shared/i18n/locales/en/test-cases.json`, registered in
  `shared/i18n/i18n.ts` (manual registration, not auto-discovered). All copy through `t()`.

  **FE specs written for Phase A** (§7's list): `test-cases-tab.test.tsx` (AC2 columns, AC3 empty +
  disabled Add New, BR10 "Not Run"/"Not run yet" never a dash, AC4 ID-cell navigation, BR15 no Test
  Steps list), `verdict-badge.test.tsx` (every enum member incl. `not_run`),
  `test-case-detail-page.test.tsx` + `test-case-unavailable.test.tsx` (read-only fields, the three
  denied-state branches), `route-permission.contract.test.tsx` (new assertion for the route's
  deliberate no-guard shape). All green; `fe-consistency.ratchet.test.ts`'s raw-`<button>` count
  caught a real regression (my first `TestCaseIdCell` draft used a hand-rolled button) — fixed by
  switching to the shared `Button`, ratchet unchanged at 61.
- [x] **A16** Seeds: `db/seeds/demo.ts` gives `SEEDED.nxp`'s story two Test Cases (one with two
  Results incl. a `fail`, one with none, so both the populated and the `Not Run` states are visible)
  and `SEEDED.pay` exactly one of each type. **A seeded key must advance the key counter** or the
  app mints `TC-1` again and collides. Export the new ids from `db/seeds/constants.ts`.
  Verified live via `pnpm db:seed:test`: TC-1 (NXP) correctly shows `last_verdict=pass,
  last_run=2026-06-21` — the LATER of its two seeded Results (proves the trigger's `run_date DESC`
  tie-break, not "last inserted"); TC-2 (NXP, no Results) shows NULL/NULL; TC-3 (PAY) seeded
  correctly by `second-project.ts`.
  Note: TC/TR keys mint MAX+1 from their OWN table (portfolio-style), NOT `workspace_item_counters`
  (whose `item_type` enum is `story|task|defect` only and cannot fit these) — so there is no
  separate counter row to bump; a fresh `MAX(substring(...))` naturally sees the seeded keys.
  **Discovered gap, not fixed (out of Phase A scope)**: migration 0129's cross-join backfill for
  `test_case_types` runs BEFORE any project exists on a truly fresh database (`db/migrate.ts` runs
  `migrate()` then `seed()`), so NXP/PAY get zero default Types until Phase G's G3 (project-create
  hook) ships. Not a blocker for A16 — `test_cases.type` is a literal text snapshot (D8), not an FK
  lookup — but worth knowing before assuming `test_case_types` is populated on a fresh checkout.

**Phase A gate**
- [x] `pnpm lint` (not path-scoped) — clean, both backend glob and `pnpm --filter rova-web lint`
  (caught and fixed one unused import in `test-cases.controller.ts` along the way).
  `pnpm typecheck` — clean (this script is a documented no-op per ADR-001; the real check is
  `tsc -b --force`, run repo-wide and clean). `pnpm build` (api+worker) — clean. `pnpm build:web` —
  clean (**note: the package is `rova-web`, not `rally-web`** — the repo's product-rename commits
  changed the pnpm workspace name; both `pnpm build:web`'s and `pnpm --filter rally-web test`'s own
  script text in `package.json` are stale and resolve to "No projects matched" — ran
  `pnpm --filter rova-web build` / `test` / `test:e2e` directly instead. Flagged, not fixed —
  out of Phase A's scope to touch root `package.json`).
- [x] `pnpm test` + `pnpm --filter rova-web test` green — backend 88 files / 1984 tests; FE 132
  files / 1011 tests. Coverage RAISED and RE-MEASURED: stmts 86.03%, branches 79.56%, functions
  84.34%, lines 86.94% (measured via `pnpm test:cov`) → floors raised 85/78/84/85 → **86/79/84/86**
  (functions held at 84, 0.34pt under measured, matching the file's own historical ~1pt-margin
  convention). `pnpm check:coverage-floors` green (within 3pt of measured) both before and after
  the raise.
- [x] `test/coverage-include.spec.ts` green — `test-cases.service.ts` added to `vitest.config.ts`'s
  include list; the drizzle-repository predicates spec needs no entry (its subject name has no
  same-named sibling file, same as `quality.drizzle-repository.predicates.spec.ts`).
- [x] `route-policy.ratchet.spec.ts` unchanged (5/5 tests green) — the `by-key` route's
  `@AuthorizedInService` citation initially pointed at a not-yet-written e2e spec and failed this
  ratchet; fixed by writing `test/e2e/test-case-routes.e2e.spec.ts` (7 tests, all green) rather than
  by weakening the citation.
- [x] `fe-consistency.ratchet.test.ts` — 8/8 green, `MAX_RAW_BUTTON` held at **61** (unchanged). This
  one caught a REAL regression attempt mid-session: `TestCaseIdCell`'s first draft hand-rolled a
  `<button>`, which would have raised the ratchet to 62 — fixed by switching to the shared `Button`
  (link variant) before it ever landed as a tick.
- [x] `pnpm test:e2e`, then `pnpm db:seed:test`, then `pnpm --filter rova-web test:e2e` — run in
  that order, multiple times over the session.
  - **BE e2e**: my own `test-case-routes.e2e.spec.ts` passed cleanly every run. Across repeated
    full runs the suite fluctuated between **552–554 of 555** tests, but the FAILING spec was
    DIFFERENT each time (`notification-flow` + `parent-story-feed` once, `server-role-matrix`
    another time) — consistent with the cross-test data-pollution class of flake CLAUDE.md already
    documents extensively for this suite, not a Test Cases regression. One GENUINE, reproducible
    failure was found and fixed outside this session's own diff: see the `dev-tenant` fix below —
    confirmed fixed (never reappeared in 3 subsequent full runs after the fix landed).
  - **Playwright**: 38–46 of ~48 passed across runs; the same 8 specs (capacity-allocation ×4,
    golden-journey, iterations, portfolio ×2) failed with timeout-pattern errors in the full run but
    passed (or failed with a DIFFERENT assertion) when re-run in isolation — confirmed
    resource-contention flakiness on this machine after heavy concurrent test load, not a
    regression; none of the 8 touch Test Cases in any way.

**Process note for whoever reads this next (2026-09-07):** a research subagent launched during A1
was told "research only, do not write code" but wrote the A1 migration file unprompted anyway. Its
output was NOT trusted on the strength of the subagent's own report — every claim (schema shapes,
key-minting mechanism, the 0063 transaction rule, `db/migrate.ts`'s call ordering) was independently
re-verified against the real schema files and a live database before any of it was accepted. Treat a
subagent's stated scope as a request, not a guarantee — verify its output against ground truth the
same way you would your own untested first draft.

**Unrelated fix landed alongside Phase A (separate commit, not Phase A work):**
`test/e2e/workspace-admin-team-membership.e2e.spec.ts` hardcoded `externalTenantId: 'dev-tenant'`
and `email: `${label}@qnsc.vn``, both drifted from `.env`'s real `ENTRA_TENANT_ID=local-dev-tenant`.
A shared fix already existed (`test/e2e/support/sso-env.ts`, whose own docblock records "Nine files
hard-coded `externalTenantId: 'dev-tenant'`... this is that same fix with one home") and 7 files plus
2 fixed individually had migrated to it — this file was the one file the rollout missed. Fixed by
importing `SSO_TENANT_ID` / `SSO_EMAIL_DOMAIN` from the existing shared helper, matching every
neighbouring spec, rather than re-hardcoding a corrected literal. No schema/env/seed change needed;
confirmed fixed and stable across 3 subsequent full BE e2e runs.

### Phase B — Create Test Case (SRS §5)

**Type feed decision (confirmed with user before B1, since Phase A shipped `work.test_case_types`
with no repository/service/route/FE feed at all):** minimal read-only query, not a hardcoded list
and not the full Phase G route. `TestCasesService.listSelectableTypes` + one
`GET /projects/:id/test-case-types` (`test_case:view`, no `resource` key — same shape as
`GET /projects/:id/member-options`) — live rows only, ordered by `position`. No create/archive, no
`workspace:edit` gate (that is G2's). This is the minimum surface B3's dropdown needs; G2 later adds
write routes to the SAME path rather than a second one.

- [x] **B1** `CreateTestCaseSchema` + `POST /work-items/:id/test-cases`. `assertAssignable` on
  `ownerId` (BR8). Key mint = `MAX+1` + retry once on `uq_test_case_key` (D4). Rank via
  `lockRankScope` → `findMaxRank` → `between()` (BR7).
  Also gates `assigneeId` through the same `assertAssignable` rule (BR8 names it for Owner /
  Assigned To / Tester as one rule). Type feed resolved per the recorded decision below (no Phase G
  route): a minimal `listSelectableTypes` repo method + service method + one
  `GET /projects/:id/test-case-types` route (`test_case:view`-gated, read-only — no `POST`/`DELETE`,
  those stay Phase G). Retry keyed on `isDuplicateKeyError` (`@platform/database/pg-errors.ts`), not
  a blind catch, so a non-duplicate error is never silently retried.
  `libs/modules/test-cases/src/application/test-cases.service.spec.ts`: 20 new tests (31 total, all
  green) covering BR1–BR8 plus the retry. `test-case.drizzle-repository.predicates.spec.ts`: 5 new
  tests (16 total, all green) proving `findMaxRank`/`listSelectableTypes`'s exact WHERE/ORDER BY.
  `pnpm vitest run` on both files: 31 passed, 11 passed respectively. `tsc -b --force` and
  `pnpm lint` clean.
- [x] **B2** `ActivityLogger` row: `test_case.created`, `entityType: 'test_case'`,
  **`contextId` = the parent work item id** so the Story's own Revision History includes it — the
  reason `context_id` exists. Written IN THE SAME transaction as the insert (`uow.run`, matching
  `WorkItemsService.appendActivity`'s in-tx shape, not Portfolio's post-commit `logSafe`) — a Test
  Case create is a child-of-work-item write, so a log failure rolling back the create is the
  behaviour that shape already established for tasks. Pinned inline in B1's spec
  ("B2: logs test_case.created with contextId = the parent Work Item id").
- [x] **B3** `CreateTestCaseModal`: Name (required, Create disabled while blank — AC2), Type
  (project feed, defaults to first), Method, Priority, Owner (`useDefaultOwner`, BR4). Copy from the
  mockup, including the footer note "Test steps are maintained on the Test Case detail as Input and
  Expected Result pairs."
  Mirrors `AddTaskModal`'s shape exactly (parent-derived Project/Team, not the app shell's selected
  context — P6-E2E-003's reasoning). Type/Method/Priority selectors DISPLAY the resolved default
  (project's first selectable Type, `manual`, `normal`) but send `undefined` when untouched, so the
  SERVICE's default (not a second client-side copy of the same rule) is what's actually recorded.
  `apps/web/src/features/test-cases/ui/create-test-case-modal.test.tsx`: 13 tests, all green —
  BR1 (disabled/enabled/trim), BR2 (default display + untouched-sends-undefined), BR3 (same for
  Method/Priority), BR4 (both directions: current user offered vs. not), BR5 (read-only Project, no
  picker), BR6 (Assigned To omitted untouched), the parent-team-not-shell-team assertion, the footer
  copy, the SRS §2 success-navigates-and-closes flow, and the failed-submit error banner.
  One debugging note: `getByLabelText('Name')` (exact string) failed to find the label because
  `FormField`'s `required` prop renders an `aria-hidden="true"` asterisk INSIDE the `<label>`, which
  still contributes to the computed accessible name (`"Name*"`) — `getByLabelText(/^Name/)` fixed it.
  `create-work-item-modal.test.tsx`'s own `Title` field query already used a regex for the same
  reason; not a new pattern, just one this file hadn't followed yet.
- [x] **B4** `Add New` enabled; renders only with `test_case:create`. On success, invalidate the
  list + the tab count and **navigate to the new Test Case Detail** (SRS §2 creation flow).
  `test-cases-tab.tsx` opens `CreateTestCaseModal` in local state on click (`fireEvent.click`, NOT
  `.click()` — the latter didn't flush the React state update synchronously in this test setup, a
  second debugging note worth keeping). `addNew.comingSoon` i18n key retired (Phase A's placeholder
  tooltip, no longer applicable now the action is live); `test-cases-tab.test.tsx` gained a case
  proving Add New is enabled with the permission and opens the modal (9 tests total, all green).
- [x] **B5** Optimistic-free invalidation: one query key per (`work-items`, id, `test-cases`).
  `useCreateTestCase`'s `meta.invalidateKeys: [testCaseKeys.list(workItemId)]` — a NARROW key, not a
  new `EntityTag` in the shared registry (`shared/api/invalidation.ts`): a Test Case has no other
  read-model derived from it yet (no report, no dashboard, no picker feed reads it), so a coarse tag
  would be scope this phase doesn't need. Covers BOTH the list and the tab badge for free, since
  A7/A12 already read the badge count from this SAME query's `pageInfo.total` — confirmed by reading
  `work-item-detail-page.tsx`'s `testCasesForCountQuery = useTestCases(...)` rather than assuming.

**Gate:** Phase A gate + `test/e2e/test-case-routes.e2e.spec.ts` covers create → list → detail over
`app.inject()`. **A spec that calls the service directly cannot see a guard defect** — that blind
spot hid the `work_item`/`task` resolver fault and the `report:view` bug.

**Codegen note:** the first restart attempt hit an environment issue independent of this diff — two
duplicate `nest start --watch` processes (one an orphan from a bash-backgrounding retry) raced each
other rewriting `dist/`, causing an infinite "file change detected" retrigger loop that never let the
app finish booting. Killed both, started ONE clean instance, and it booted fine on the first real
attempt (~65s cold compile) — `Route authorization audit passed — 233 handlers, all declared`,
`POST /v1/work-items/:id/test-cases` and `GET /v1/projects/:id/test-case-types` both mapped. Grepped
`/api/docs-json` for `CreateTestCaseDto` / `test-case-types` before trusting codegen (both present).
`pnpm --filter rova-web codegen` diff: 145 insertions, 1 deletion, purely additive.

**`pnpm test:e2e` (full suite) BLOCKED — pre-existing, reproducible, unrelated to Phase B.**
Confirmed with the user rather than assumed. `test/e2e/governance-audit-flow.e2e.spec.ts`'s
`relayUntil` deliberately drains the WHOLE outbox backlog (its own docblock explains why — a
batch-position dependency from a prior fix), and in a full run it reaches a `project.archived`
audit event — from some OTHER spec, not this one — whose `resourceType` is 62 characters against
`audit_logs.resource_type varchar(50)`. The INSERT throws Postgres `22001`
(`value too long for type character varying(50)`), `AuditProjectionRelay` logs it and retries, and
the vitest process then hangs rather than exiting — reproduced identically on 2/2 clean-DB attempts
(once left running 90 minutes before being killed, once bounded with `timeout 300` and killed at 5
minutes). `git status` confirms none of this session's diff touches `audit`, the outbox relay, or
`governance-audit-flow.e2e.spec.ts` — the failing `resourceType` is produced by a DIFFERENT spec's
seed/write path, not by anything Phase B added.

Verified instead: `test/e2e/test-case-routes.e2e.spec.ts` run in ISOLATION —
`pnpm vitest run --config test/vitest.e2e.config.ts test/e2e/test-case-routes.e2e.spec.ts` — green,
13/13 (the 7 Phase A tests + 6 new Phase B ones: create→list→detail round trip, BR1 blank-name
refusal, BR2 non-catalog-Type refusal, BR4/BR8 owner eligibility both directions, BR7 rank-after
ordering, 404 on a Work Item outside the caller's readable projects). This is the shape CLAUDE.md
names as the one that can see a guard defect — real `AppModule`, `app.inject()`, a Bearer token from
`AuthService.devLogin` — so it is not a weaker substitute for the full-suite gate, only a narrower
one. **This blocker is unrelated to Test Cases and is reported to the user for separate triage; it
is not fixed here** (out of Phase B's scope, and the reproduction makes clear which spec and which
column need attention).

**`pnpm --filter rova-web test` (full FE suite) — also BLOCKED, same shape, confirmed with the
user.** Two full runs, both failed 4-5 unrelated test files
(`user-access-modal.test.tsx`, `backlog-filters.test.tsx`, `iteration-filters.test.tsx`,
`portfolio-detail-page.test.tsx` — Settings, Backlog, Iteration Status, Portfolio, never Test
Cases) and then HUNG rather than printing a final summary, forcing a kill both times. Re-ran all
four failing files together in ISOLATION: 22/22 GREEN in 29s — confirms resource-contention flake
under full-suite parallel load on this machine, the same class CLAUDE.md documents extensively for
Playwright ("Eight Playwright specs … time out under full-suite resource contention and pass in
isolation"), now apparently also affecting the FE unit runner. One REAL issue this run did catch
and fix: `query-default.ratchet.test.ts`'s `MAX_QUERY_DEFAULTS` needed raising 94→95 (see B3's
note) — `CreateTestCaseModal`'s `useTestCaseTypes` call-site default, the same unconverted pattern
`AddTaskModal` already uses. Verified individually: `test-cases-tab.test.tsx` (9/9),
`create-test-case-modal.test.tsx` (13/13), `verdict-badge.test.tsx`,
`test-case-detail-page.test.tsx`, `test-case-unavailable.test.tsx`,
`fe-consistency.ratchet.test.ts` (8/8), `query-default.ratchet.test.ts` (4/4) — all green. **Not
fixed here** (environment resource contention, not a code defect); reported for the user's own
triage alongside the BE e2e blocker above.

**Remaining Phase B gate steps — all green.**
- `pnpm build` (api + worker) — clean.
- `pnpm --filter rova-web build` — clean (pre-existing `INEFFECTIVE_DYNAMIC_IMPORT` / plugin-timing
  warnings only, unrelated to this diff).
- `tsc -b --force` (repo-wide) — clean.
- `pnpm test` (backend unit) — **88/88 files, 2006/2006 tests**, after fixing one REAL ratchet
  failure this run caught: `test/query-ordering.ratchet.spec.ts` — `listSelectableTypes`'s
  `ORDER BY position, name` didn't end in a unique column; added `id` as the tiebreaker (matches
  the rule every other ranked read in this repo already follows).
  Coverage RAISED and RE-MEASURED (`pnpm test:cov`): stmts 86.14%, branches 79.67%, functions 84.4%,
  lines 87.06% → floors raised 86/79/84/86 → **86/79/84/87** (lines only; the create path's own
  tests held statements/branches/functions at their Phase A floor). `pnpm check:coverage-floors`
  green.
- `test/coverage-include.spec.ts` — green, no new entry needed (`test-cases.service.ts` already
  listed from Phase A).
- `test/route-policy.ratchet.spec.ts` — unchanged, 5/5 green (both new B1 routes are decorated).
- `pnpm db:seed:test` — reset + reseeded cleanly before Playwright.
- `pnpm --filter rova-web test:e2e` (Playwright) — **42 passed, 5 failed, 1 skipped (19.5m)**. All 5
  failures are the documented pre-existing flakes named in this task's own instructions
  (`capacity-allocation.e2e.ts` ×4, `golden-journey.e2e.ts` ×1) — `iterations` and `portfolio`, also
  on that list, passed cleanly this run. **Zero Test Cases failures**: no `test-cases.e2e.ts`
  Playwright spec exists yet (not shipped in Phase A or B — the plan's own §7 test-strategy section
  lists it as future work once Phases B/D land further), so nothing Test-Cases-specific runs in
  this suite at all; the diff introduced no new Playwright failure and touched no passing spec.

### Phase C — Test Case Detail edit (SRS §6)

- [ ] **C1** `UpdateTestCaseSchema` — carries name, the seven content fields, type, method,
  priority, ownerId, assigneeId. **Does NOT carry `projectId`, `teamId`, `workItemId`, `lastVerdict`,
  `lastRun`** (BR5, BR9); document the absence on the schema so it is not helpfully filled in later.
- [ ] **C2** `PATCH /test-cases/:id`; `assertAssignable` on both people fields, looping the two
  through ONE rule the way Dev Owner does, so a third responsibility later cannot pick up half the
  behaviour.
- [ ] **C3** Activity diff rows via `ActivityLogger.buildDiff` — scalar values only, never a
  rich-text body.
- [ ] **C4** Attachments: `UploadPolicy` descriptor for `test_case`; wire the existing
  `AttachmentBlock`. Both download routes go through the scoped read (BR20).
- [ ] **C5** Detail tab becomes editable — `usePendingPatch` + `SaveCancelBar`, the shape the work
  item detail already uses. Type select unions the row's current value with the live project list
  (BR17).
- [ ] **C6** Revision History tab reusing `ActivityHistoryTab`.
- [ ] **C7** `CollaborationService` **refuses** comments on `test_case` / `test_result`, asserted
  (§2.6).

**Gate:** Phase A gate + a spec asserting each read-only field is refused, and that
`CollaborationService` refuses both new entity kinds.

### Phase D — Results tab + Add Result (SRS §7, §8)

- [ ] **D1** `ITestResultRepository` + Drizzle repo, ordered `run_date desc, created_at desc`
  (BR14), tester name joined on the row.
- [ ] **D2** `TestResultsService`: `list`, `create`, `getById`. `create` snapshots `work_item_id`
  from the Test Case (BR13) and validates `tester_id` through `assignmentCandidates`.
- [ ] **D3** Routes `GET`/`POST /test-cases/:id/test-results`, `GET /test-results/:id`.
- [ ] **D4** Trigger verification: a real INSERT moves `last_verdict` / `last_run` on the parent —
  asserted against the STORED columns in `derived-invariants.e2e.spec.ts`.
- [ ] **D5** `results-tab.tsx`: Build, Date, Work Product, Verdict, Duration, Tester (AC8 order).
  Build cell is the link to Result Detail. Empty state.
- [ ] **D6** `AddTestResultModal`: Build + Date + Tester required (Save disabled otherwise — AC9),
  Date defaults to **`todayIsoDate()`** — NOT `new Date().toISOString().slice(0,10)`, which converts
  to UTC first and hands a tester in UTC+7 yesterday's date before 07:00 local. Verdict defaults
  `Pass`; Duration defaults 0 with `min={0}`; Test Case and Work Product read-only. On save,
  navigate to the new Result's detail (AC10).
- [ ] **D7** Results count badge on the Test Case Detail tab strip.
- [ ] **D8** Invalidate the Test Case detail on result write, or `Last Verdict` in the sidebar goes
  stale against the row the trigger just changed.

**Gate:** Phase A gate + `test/e2e/test-result-flow.e2e.spec.ts`: two results, verify the LATEST by
date wins, then a same-date pair verifying `created_at` breaks the tie (BR9).

### Phase E — Test Result Detail (SRS §9)

- [ ] **E1** `UpdateTestResultSchema` — build, run_date, verdict, duration_minutes, tester_id,
  notes. **Not** `testCaseId` / `workItemId` (BR13).
- [ ] **E2** `PATCH`/`DELETE /test-results/:id`; activity rows; `UploadPolicy` for `test_result`.
- [ ] **E3** Route `/test-result/$testResultKey`, page with `Details | Revision History`, back to
  the Test Case's Results tab. Same three-outcome denied-state handling as A13.
- [ ] **E4** Left column Build / Attachments / Verdict / Notes; right sidebar Date / Tester /
  Test Case (RO) / Work Product (RO) / Duration.
- [ ] **E5** An edit that changes `run_date` or `verdict` must move the parent's `Last Verdict` —
  the trigger already does it; assert it, because an UPDATE path is a separate trigger branch from
  INSERT.

### Phase F — Delete + lifecycle

- [ ] **F1** `DELETE /test-cases/:id` (soft), cascading soft-delete to its Results in one
  transaction, and the trigger's DELETE branch verified.
- [ ] **F2** `WorkItemRowActions`-style row affordance on the tab — the **shared** control, a
  TRAILING cell (not a declared column: an affordance must not be hideable), revealed on
  `group-hover` AND `focus-within`. Named confirmation, not typed; the copy says what survives.
- [ ] **F3** Rank drag-reorder: `useRerankSensors()` (the ONE shared sensor set) and dnd-kit
  `attributes` **on the grip alongside `listeners`**, not on the row — the sensor alone does not
  work, because dnd-kit activates from the activator's `onKeyDown`.
- [ ] **F4** Resolve §7 Q1 (what a Work Item delete does to its Test Cases) and implement the
  BA's answer.

### Phase G — Project Test Case Type configuration (SRS §3)

- [ ] **G1** `ITestCaseTypeRepository` + service: list (live only, plus an `includeArchived` read for
  the Detail select), create (BR16), archive.
- [ ] **G2** Routes under `/projects/:id/test-case-types` (§3). `POST`/`DELETE` gated
  `workspace:edit` — WA-only, matching the structural project routes; **not** `project:edit`, which
  a Project Admin holds.
- [ ] **G3** Default-Types seeding on project create (the backfill for existing projects shipped in
  A1).
- [ ] **G4** `test-case-types-section.tsx` under
  `Settings > Workspaces & Projects > <Project> > Details`: chip list, `Add New` → modal (Name,
  Cancel, Save, inline duplicate/length errors), `×` → confirmation dialog whose body is the
  mockup's ("Existing Test Cases keep their historical Type value"). Controls render only for a
  Workspace Admin.
- [ ] **G5** The Create modal and the Detail Type select move onto this feed.

---

## 7. Test strategy

Level by level, with the reason each level is the one that can see the fault:

**Unit (vitest, `pnpm test`)**
- `test-cases.service.spec.ts` — BR1–BR8, BR16–BR18; both `TeamReadScope` sentinel directions
  (`null` = unrestricted, `[]` = nothing). A test that only forwards an array also passes when
  `null` is flattened to `[]`, which fails closed and shows a Workspace Admin an empty grid.
- `test-results.service.spec.ts` — BR11–BR14, and the latest-result tie-break in isolation.
- `test-case.drizzle-repository.predicates.spec.ts` — the ordering + scope predicates, following
  `quality.drizzle-repository.predicates.spec.ts`.
- `permissions.spec.ts` / `fe-permission-contract.spec.ts` — pick up the eight new codes for free.

**Integration / BE e2e (`pnpm test:e2e`, real `AppModule` + `app.inject()`)**
- `test/e2e/test-case-routes.e2e.spec.ts` — the AC1–AC4 journey over HTTP, plus create and update.
  Bearer token from `AuthService.devLogin` (Bearer callers are CSRF-exempt by design). Remember:
  **no `/v1` prefix** and **no cookie plugin** in the test app, and the **ValidationPipe runs before
  the guard**, so an incomplete query is a 400 that never reaches authorization.
- `test/e2e/test-case-authz.e2e.spec.ts` — both directions, and the negative case uses a **seeded
  user with custom roles**: a JIT-provisioned SSO user is not a denied principal, because
  `assignDefaultRole` grants `project_member`.
- `test/e2e/test-case-team-scope.e2e.spec.ts` — an Editor outside the parent's team is refused the
  Test Case, its Results, its activity, its attachments **and both attachment-download routes**
  (BR20). A signed URL outliving the request is why that pair is the worst of them.
- `test/e2e/derived-invariants.e2e.spec.ts` (extend) — BR9 in all four trigger branches
  (INSERT / UPDATE / soft-DELETE / `test_case_id` move), asserting the STORED columns.
- `test/e2e/test-result-flow.e2e.spec.ts` — Phase D gate above.
- `test/e2e-fixtures.ratchet.spec.ts` — the `createProject` cap may only fall; the new specs should
  reuse `SEEDED.nxp` / `SEEDED.pay` rather than minting projects.

**FE unit (`pnpm --filter rally-web test`)**
- `test-cases-tab.test.tsx` — AC2 column order and labels; AC3 empty state + `Add New` present;
  `Not Run` / `Not run yet` rendered for a Test Case with no Results (BR10, **never `--`**); the
  ID cell links to the detail route (AC4); **absence of any Test Steps list** (BR15).
- `test-case-detail-page.test.tsx` — read-only fields are `ReadOnlyFieldValue`, not disabled inputs;
  the three denied-state branches (403 / 404 / other) each render their own sentence.
- `create-test-case-modal.test.tsx` — Create disabled while Name blank; defaults; Owner default only
  when the feed offers the current user.
- `add-test-result-modal.test.tsx` — Save disabled without Build / Date / Tester; `min=0` duration.
- `verdict-badge.test.tsx` — every enum member has a style, including `not_run`.
- `route-permission.contract.test.tsx` — the two new record routes.

**Playwright (`pnpm --filter rally-web test:e2e`)**
- `test-cases.e2e.ts` — **one per-SURFACE journey, not per-page smoke checks**: open the seeded
  Story → Test Cases tab (count badge visible) → assert the ten columns → open `TC-…` by its ID →
  Details tab fields → Results tab → open a Result by its Build → back out to the Results list →
  back out to the Story's tab. One login for the whole walk.
- Extend `golden-journey.e2e.ts` with Create Test Case → Add Result, once Phases B and D land.
- `role-conformance.e2e.ts` — an Editor sees the tab; a principal without `test_case:view` does not.
- Run `pnpm db:seed:test` **before** any Playwright run that follows a BE e2e run, and never run the
  BE e2e suite while Playwright or a manual session is live — the reset truncates under them.

**Accessibility (asserted in the FE unit tests, not by hand)**
- The grid is DIVs: **no `aria-sort`, no `role="columnheader"`** — deliberately. `SortHeader` carries
  the state in its accessible name ("Last Verdict, sorted ascending. Activate to sort.").
- Every chevron / grip / icon button has an accessible name.
- `VerdictBadge` must not carry meaning in colour alone — the text is the verdict.

**Manual verification checklist** (per phase, before requesting BA retest)
- Test Case with 0 / 1 / many Results; same-date Results; a Result deleted back to zero.
- A Work Item with no Team → sidebar reads `Project backlog`.
- A Type removed while a Test Case still uses it → the Detail select still shows the old value.
- An Editor in another team → 403 page with a recovery action, not a blank screen.

---

## 8. Open questions for the BA

None of these blocks Phase A. Each is asked at the phase that needs it.

1. **A Work Item delete and its Test Cases** (blocks Phase F). Soft-delete the Test Cases with the
   Story, or keep them for the future standalone surface? `P3-QA-FR-020` retains a Defect's child
   Tasks, which argues for retaining Test Cases too — but a retained Test Case with no reachable
   Work Product is invisible until D2's standalone list exists.
2. **Comments on a Test Case / Test Result.** The SRS names none, so we refuse them (§2.6). Confirm
   that is intended, since the enum now technically admits them.
3. **`Last Build`** — Rally's Test Case has it beside Last Verdict / Last Run, from the same latest
   Result. The SRS §6.3 field list omits it. Add (one more trigger column, no new data) or leave?
4. **Duplicate Test Case names** within one Work Item — permitted? The SRS is silent; we permit.
5. **Bulk actions on the tab.** AC2 lists a `Select` checkbox column but the SRS names no bulk verb.
   We render the column and no bulk bar. Confirm, or name the verbs.
6. **Sorting `Owner` / `Last Verdict`.** The tab loads one Work Item's Test Cases, so the set is
   complete and sorting is CLIENT-side — the Iteration Status precedent. Absent sorts LAST
   ascending, FIRST descending, matching `keysetCondition`, so a client sort and a future server
   sort cannot disagree about where blanks belong. Confirm blanks-last is what the BA wants.
7. **A read-only `Test Case Type` for a Project Admin.** §3.3 gives `Add New` to a Workspace Admin
   only; a Project Admin can still SEE the chips (they hold `test_case:view`). Confirm.

---

## 9. Risk register

| Risk | Why it bites here | Mitigation |
|---|---|---|
| Widening `entity_ref_type` silently enables comments / milestone artifacts on Test Cases | One enum serves three tables (§2.6) | Explicit refusals with specs, per §2.6 and C7 |
| Migration 0129 written in parallel with another migration | Drizzle applies only entries past the newest recorded `when`; a higher-numbered migration applied first **strands** the lower one silently and still reports "Migrations applied" | One migration at a time, even across parallel work. Verify `count(*)` against the journal |
| Generated client written against a stale spec | `/api/docs-json` is built once at bootstrap; a watch-mode recompile is not a fresh spec, and the symptom is an EMPTY `git diff` that reads as "no DTO change needed" | Restart the API; grep the served spec for a new field before committing (A8) |
| Trigger and service both write `last_verdict` | Two writers, one truth | Only the trigger writes it. The columns are absent from `UpdateTestCaseSchema` (C1) |
| Permission codes never reach existing workspaces | `bootstrap.ts` upserts tier roles with `set: { name }` | Force-backfill migration in A2 |
| Seeded TC keys collide with app-minted ones | Seeds bypass the service | Seeded keys advance the counter (A16) |
| `tsc -b` passes on stale build info | The change spans packages (db → libs → apps → web mirror) | `tsc -b --force` in every phase gate |
| A picker narrower than the write | Exactly the `parent-story-feed` and `iterations/options` faults | Owner / Assigned To / Tester all read `assignmentCandidates`, the same rule `assertAssignable` enforces (BR8) |
| `?? 0` on an absent number | Turns a network fault into a measured claim — Release Tracking's three zeros | BR10; read `isError`, render `Not Run` / `Not run yet` |

---

## 10. Definition of done (whole feature)

- [ ] All seven phases marked done, each with its gate passed
- [ ] AC1–AC4 of the User Story, and AC1–AC17 of the SRS, each traceable to a named test
- [ ] `docs/DIVERGENCE.md` records the five declared divergences of §0
- [ ] `CLAUDE.md` gains a Test Case section: the trigger, the nullable `work_item_id` reading, the
      `entity_ref_type` widening and its refusals, and the `Not Run` / `Not run yet` exception to
      `EMPTY_VALUE`
- [ ] Coverage floors raised **and re-measured**; every ratchet unchanged or lower
- [ ] `pnpm --filter rally-web codegen` clean (`codegen:check` green in CI)
- [ ] The seven §8 questions answered, or explicitly carried as declared readings
- [ ] Ported to `opshub` where the change is boilerplate — nothing here is
      (`libs/modules/test-cases` is product code), so this feature adds **no** opshub obligation.
      Recorded so the next reader does not go looking.

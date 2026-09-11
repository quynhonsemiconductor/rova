# Rova — working notes

Conventions that already exist in this repo but are easy to miss, plus the
non-obvious tooling behaviour. Read this before changing build, auth, or DB code.

## Where the real documentation lives

| Topic                                                 | File                                                    |
| ----------------------------------------------------- | ------------------------------------------------------- |
| Frontend conventions (FSD layers, shared/ui, i18n)    | `apps/web/FRONTEND_CONVENTIONS.md`                      |
| Entity surface pattern (list + detail scaffolds)      | `apps/web/ADR-001-entity-surface-pattern.md`            |
| Component migration state + ratchets                  | `apps/web/FRONTEND_COMPONENT_AUDIT.md`                  |
| Design specs and wave plans                           | `docs/superpowers/{specs,plans}/`                       |
| Auth model shared with opshub (+ what opshub must do) | `docs/superpowers/specs/2026-07-28-auth-convergence.md` |
| Declared differences from opshub                      | `docs/DIVERGENCE.md`                                    |
| SCM (GitHub App) setup                                | `docs/scm-github-app.md`                                |
| Incidents behind the rules below                      | `docs/lessons/` (linked per section)                    |

## Local stack

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres + valkey + localstack
pnpm db:migrate                                  # applies migrations AND seeds
pnpm start:dev                                   # API with watch
pnpm --filter rova-web dev                      # SPA (proxies /v1 → API)
```

## Commands

Backend commands run from the repo root (the backend IS the root package); the SPA is the
only pnpm workspace member, so it is reached with `--filter rova-web`.

```bash
export NODE_AUTH_TOKEN="$(gh auth token)"   # @quynhonsemiconductor/* live on GitHub Packages (read:packages)
pnpm install                                # root (backend) + apps/web

pnpm build                                  # nest build api + worker
pnpm build:web                              # tsc -b && vite build
pnpm lint                                   # {apps/api,apps/worker,libs,db}/**/*.ts — run this, not path-scoped eslint
pnpm typecheck                              # tsc --noEmit (use `tsc -b --force` for cross-package changes)

pnpm test                                   # backend unit (vitest)
pnpm test:cov                               # coverage — floors are a ratchet, see below
pnpm test:e2e                               # backend e2e (test/vitest.e2e.config.ts) — resets the DB
pnpm --filter rova-web test                # SPA unit (vitest + testing-library)
pnpm --filter rova-web test:e2e            # Playwright
```

One test / one case:

```bash
pnpm vitest run libs/modules/work-items/src/application/work-items.service.spec.ts
pnpm vitest run -t "refuses a cross-project move"
pnpm vitest run --config test/vitest.e2e.config.ts test/e2e/editor-team-scope.e2e.spec.ts
pnpm --filter rova-web exec vitest run src/pages/portfolio/portfolio-page.test.tsx
pnpm --filter rova-web exec playwright test golden-journey --headed
```

Database:

```bash
pnpm db:migrate            # migrations + bootstrap seed (see the seeding note below)
pnpm db:seed               # demo fixtures on top
pnpm db:seed:test          # RESETS, then seeds fixtures — run after a BE e2e run, before Playwright
pnpm db:studio             # drizzle-kit studio
pnpm --filter rova-web codegen   # regenerate the API client from a RUNNING local API
```

Ordering that bites: a BE e2e run truncates at its START and leaves debris, Playwright and a manual
session both die under that truncation, and `codegen` needs a freshly restarted API. All three are
expanded in the section below.

## Architecture

Four deployables from one repo, sharing `libs/` and `db/`:

- **`apps/api`** — NestJS 11 on Fastify. Thin: it composes modules from `libs/modules/*` and owns
  bootstrap (CSP, Swagger opt-in, the global exception filter that maps `@platform` domain
  exceptions to HTTP).
- **`apps/worker`** — a second Nest app over the same modules. It owns the CRON and RELAY loops:
  the report snapshot job (`cron/`), the email relay, the Entra guest-invite relay, the notification
  outbox, audit and SCM. Anything periodic or outbox-draining lives here, never in the API — and a
  running worker is a competing consumer of the same outbox tables the BE e2e suite waits on.
- **`apps/web`** — React 19 + Vite SPA in Feature-Sliced Design (`app / pages / widgets / features /
entities / shared`). Its API client is GENERATED from `/api/docs-json` and COMMITTED. Browser auth is
  BFF: the SPA holds no tokens and talks to `apps/web/functions/v1/[[path]].ts` (a Cloudflare Pages
  Function) which proxies to the API with an opaque session cookie.
- **`db/`** — Drizzle schema, hand-written migrations, seeds, and `permissions.catalog.ts`. It ships
  as its own migrator image, which is why the catalogue lives outside `libs/`.

**A domain module is four layers**, and the direction is inward
(`libs/modules/<name>/src/{interface,application,domain,infrastructure}`):

| layer            | holds                                                          |
| ---------------- | -------------------------------------------------------------- |
| `interface/http` | controllers, `@RequirePermission`, zod DTOs (the OpenAPI shape) |
| `application`    | services — business rules, transactions, cache invalidation     |
| `domain/ports`   | repository interfaces the service depends on                    |
| `infrastructure` | Drizzle implementations of those ports                          |

Cross-module code goes to `libs/shared-kernel` (pure domain types, the permission re-export),
`libs/platform` (config/env schema, HTTP concerns, CSRF, observability façades) or `libs/contracts`.
Modules import each other by ALIAS (`@modules/access`), never by relative path — and deep-import when
a barrel would close a cycle (`WorkspaceService` → `ApiTokensService`).

**Three facts decide most backend changes**, each detailed in its own section below:

1. `libs/modules/access` is the single authorization decision point — `PolicyGuard` plus
   `AccessService` (`listReadableProjectIds`, `resolveTeamScope`, `assertTeamInScope`). No other
   module may re-implement a scope rule.
2. Permissions come from the DATABASE on every check, never from the token, and a new permission
   code needs a backfill migration as well as a catalogue entry.
3. Test gates are RATCHETS, not targets — coverage floors, route-policy counts, FE consistency,
   e2e fixture counts. They may only move one way, and they must be re-measured when raised.

## Tooling behaviour that surprises people

Coverage floors are a **ratchet** (`pnpm check:coverage-floors` fails when a floor drifts more than 3
points behind measured — raise them with coverage, never lower them). The SPA API client is
**generated and committed**, so a contract change needs a codegen round. `pnpm lint` is repo-scoped on
purpose; a path-scoped `eslint` misses the boundaries rules.

Full account — every invariant with the incident that produced it: [`docs/lessons/tooling.md`](docs/lessons/tooling.md)

## Fixtures: two projects, one reset, no leaks

**The seed produces EXACTLY two projects, and that is load-bearing.** `SEEDED.nxp` carries the depth —
three iterations (finished / active / future), two releases, an Epic with seven Features, a draft AND a
published capacity plan, frozen Burndown + burnup history, SCM links, attachments, notifications.
`SEEDED.pay` mirrors every entity TYPE with one row each, so anything needing a _second_ project
(isolation, permission scoping, cross-project refusals, "another release") has one waiting. Both are
exported from `test/e2e/support/flow-harness.ts`.

- **`pnpm db:seed:test` RESETS before seeding**, via `db/seeds/reset.ts`. The BE e2e suite does the same
  once per run (`test/e2e/support/global-setup.ts`, one shared table list). `E2E_SKIP_RESET=true` opts
  out when bisecting.
- **The reset is on the fixture ENTRYPOINT, never inside `seed()`.** `db/migrate.ts` calls `seed()` when
  `SEED_ON_DEPLOY` is set, and truncating a deployed database because a migration ran would be
  catastrophic.
- **Why a reset and not idempotent upserts.** The fixtures use fixed UUIDs with `onConflictDoNothing`,
  which survives a re-run but not a database other things wrote to. **Item keys are unique per
  WORKSPACE** (`uq_portfolio_item_key`, `uq_work_item_key`), not per project, and tests mint them from
  `workspace_item_counters` — so a leftover `US-3` makes the fixture's `US-3` conflict and vanish
  SILENTLY. That happened twice while this was written: once `EP-1`/`FE-1` took an entire project's
  portfolio with them, surfacing three steps later as a foreign-key error on an allocation.
- **A seeded key must also advance the counter**, or the app mints it again and collides on the next
  create.
- **Do NOT run the BE e2e suite while Playwright or a manual session is live.** The reset truncates
  under them. Eight Playwright specs failed at ~21s each exactly that way.
- **And run `pnpm db:seed:test` AFTER a BE e2e run, before Playwright.** The reset is at the START of
  the BE run, so the suite leaves all 303 tests' debris behind — hundreds of extra projects,
  iterations and teams. `golden-journey.e2e.ts` then failed on the Add Item step (the modal stays open
  because the server refused the create), and it reproduced on a clean checkout with the changes
  stashed, so it is the database and not the diff. `pnpm db:seed:test` cleared it. Stash-and-rerun is
  the cheap way to tell the two apart before hunting a phantom regression.
- **The e2e suite used to leak ~84 projects per run with no teardown anywhere** — 37 files, every
  `afterAll` closing the app and cleaning nothing. Twice that pushed `portfolio_items.rank`
  (`varchar(255)`, extended by appending) to exactly 255 characters at ~1,900 items, after which every
  insert failed with `value too long for type character varying(255)` and the suite could not run at
  all. `test/e2e-fixtures.ratchet.spec.ts` caps the `createProject` count so it can only fall.
- **Playwright is per-SURFACE journeys, not per-page smoke checks.** Six files holding one or two
  assertions each — and each paying a full login — were merged into the surface they belong to. A test
  named "header, tabs and shared Artifacts tab render" is a smoke check; the merged spec walks list → ID
  column → detail → tabs in one navigation.

## Reporting (Phase 6) — what is frozen, what is live

**Burndown is FROZEN history; Velocity and Team Capacity are LIVE queries. Never unify the two paths.**
Snapshots run hourly and write only TODAY's *workspace-local* date; a missed day stays a GAP and
interpolation is prohibited. **Eligibility must be counted in the SAME scope as the measurement**, and a
LIVE fact must not outrank frozen history. `work_items.accepted_date` and `iterations.timebox_group_id`
are TRIGGER-maintained because seeds write these tables directly.

Full account — every invariant with the incident that produced it: [`docs/lessons/reporting.md`](docs/lessons/reporting.md)

## Team Status and Team Capacity are ONE population

The Team Capacity SRS says it twice — the scoped Task set comes from "the Task's PARENT Story/Defect
Project, Team and Iteration assignment", and Capacity "must use the same source/table/API domain as
`Track > Team Status`". Three things had them disagreeing, all now pinned by
`test/e2e/team-status-agreement.e2e.spec.ts`:

- **The team predicate is three-tier on BOTH sides**: `coalesce(task.team_id, parent.team_id,
iteration.team_id)`. Team Status used a strict `tasks.team_id = ?`, and a task's team only DEFAULTS
  to its parent's (SRS P1-04) — so a Story that carries the team while its task does not is an ordinary
  shape, and SQL equality never matches NULL. Those tasks vanished from Team Status while Team Capacity
  counted them. The reporting file's comment already claimed parity; it was true of the
  iteration-membership half and false of the team half.
- **A soft delete does not cascade to `work.tasks`** (the FK is `ON DELETE cascade`, which a soft
  delete never fires). Team Status LEFT-joined the parent, so orphaned tasks were still counted with a
  blank Work Product column, while Iteration Status and the Phase 6 projection inner-join and exclude
  them. Both surfaces now inner-join.
- **`member_capacity` is unique on `(project_id, team_id, iteration_id, user_id)`**, so a member on two
  teams has two legitimate rows in one iteration. `getCapacities` filtered on iteration + user only and
  collapsed into a `Map<userId, hours>` — last row won, non-deterministically, and `upsertCapacity`
  re-resolves its team from the iteration, so an edit could overwrite a different team's number than
  the one displayed. It now takes the team key and SUMs per member (under All Teams, where the screen
  groups by MEMBER, the total of their per-team allocations is the honest answer).

**Editing Estimate on Team Status must send `estimateHours` ALONE.** It used to also set `todoHours`
whenever the caller had not, which defined the field before `WorkItemsService` saw it and so bypassed
the once-only gate (`input.todoHours === undefined && item.todoHours === null`) — the copy then
happened on every estimate edit, re-inflating a completed task's auto-zeroed To Do and moving the
Iteration Status total, the Tasks-tab total and the next Burndown snapshot with it. The rule lives in
the service; the other two edit surfaces already did this correctly, and this screen's own UI comment
described the behaviour it did not have.

## A Team roster is staffed FROM the project, and the Workspace Admin is a row on it

Two BA findings of 2026-08-21, and both reverse a sentence that is still in the SRS. Read which
sentence before touching either.

- **A team member must already hold access to one of the team's projects** (`TEAM_MEMBER_NOT_PROJECT_MEMBER`,
  `TeamService.addTeamMember`). The Add-member control was an inline popover over every active
  WORKSPACE user, so on a project with no members of its own it still offered all four workspace users
  — "users who do not belong to Project X are exposed as Team member candidates". It is an `Add` button
  and a `SelectionModal` now, and the candidates are the project's members plus active Workspace
  Admins, minus the existing roster.
  - **This REVERSES Phase 1 SRS §2A's "User project access is derived from team membership", and the
    BA has since finished the reversal.** `PM-FR-021` (`c42df59`, 2026-08-22) states it outright:
    "Adding or removing a Team member never creates or changes Project Access." So **RBE-06 IS
    RETIRED** — `grantTeamRosterProjectAccess` and `teamRosterAccessLevel` are gone, from all three
    writes (create, edit, add-member), and the team form no longer sets an access level at all
    ("Project Access is read-only in this flow"). Access comes first, then membership; the candidate
    rule is what guarantees a member already has it.
  - **Nothing is invalidated by a roster write any more.** The assignment cache is keyed on
    `project_members`, which these writes no longer touch, and team SCOPE is read live from
    `team_members` (`AccessService.listScopedTeamIds`) rather than from the cache.
  - **A TEAM LEAD IS ENROLLED, not refused.** `PM-FR-021`/AC15 say a lead "must be an active Team
    member", and the same commit's addendum states it as an identity — "an active Team Lead is an
    operational Team member". Refusing would make "create a team with a lead" impossible in one call,
    which the BA's own E2E-002 journey does, so `leadInclusiveRoster` adds the lead to the roster on
    create and on any patch that moves either side. The lead still passes the candidate rule; enrolment
    is not a way around it. The SPA offers only ticked/rostered members as lead.
  - **A WORKSPACE ADMIN is admitted with no project row at all**, by the `isWorkspaceAdmin`
    short-circuit. §2.1 keeps them off `work.project_members`, so a membership test would exclude
    exactly the principals the 2026-08-20 feature below exists for.
  - **The check is against ANY actively linked project, not every one.** A team can serve several and
    `POST /teams/:id/members` carries no project, so "every" would make a multi-project team almost
    unstaffable. A team with NO active link admits any active workspace member: there is no project to
    be outside of.
- **Project `Users & Permissions` always shows the active Workspace Admins**, as synthesized read-only
  rows (`ProjectsService.listProjectMembers`, `isWorkspaceAdmin` on the row). The screen used to read
  "No members in this project yet." on a project whose only authority was a WA — the least true
  sentence available, since the reader was usually that admin.
  - **This reverses §5.2:138 "Workspace Admin is excluded from rows and candidates" — the ROWS half
    only.** Candidates still exclude them (`Add Existing User`, `listProjectMemberOptions`), nothing is
    written to `work.project_members`, and `memberCount` counts the table so it does not move.
  - **The real row is still filtered first**, so a pre-0118 leftover or a seed-written row cannot
    appear as an editable member beside the system row. The person shows once.
  - **`isWorkspaceAdmin` is the flag to branch on, never `accessLevel === null`** — a null level
    already means "team-derived row" on a real member.
  - **`useProjectMembers` drops those rows and `useProjectAccessRoster` keeps them.** One query key,
    two projections: six other call sites (two owner pickers among them) were written against real
    members and §2.1 still says a WA is not one.

## A Workspace Admin may be a TEAM member, and still not a Project user

BA feature, 2026-08-20. This REVERSES half of §2.1 and leaves the other half standing, so read which
half before touching either.

- **Team membership is operational scope.** Adding a Workspace Admin to a Team writes the
  `team_members` row and NOTHING else: `grantTeamRosterProjectAccess` runs with
  `onWorkspaceAdmin: 'skip'`, so RBE-06's `editor` grant — the rule that gives every other roster row
  project access — does not fire for them. Their authority already comes from the workspace-wide
  grant, which is why the AC is a claim about what is ABSENT after the write, and why it is asserted
  over real HTTP in `test/e2e/workspace-admin-team-membership.e2e.spec.ts` rather than against a
  mocked grant writer.
- **§2.1 still keeps them off `work.project_members`**, so `selectWorkspaceAdminUserIds` and the
  project-access candidate list (`projects-access-tab.tsx`) are unchanged. A blank access level on a
  team roster row is therefore ambiguous, and that is what the badge fixes: the roster carries
  `isWorkspaceAdmin` per row (`TeamService.listTeamMembersForReader`, one `AccessService`
  lookup per read, none for an empty roster) and the row renders `Workspace Admin` — never `Admin`
  or `Editor`, which would state the thing the rule forbids.
- **Nothing enrolls them automatically.** `createTeam` adds only the `memberUserIds` it is given, and
  `assertMembers` requires nothing but active workspace membership. Do not add a convenience that
  seeds every team with the admins.
- **They were already a valid Project Owner** — `listMemberOptions` unions in `projects.lead_id`
  precisely because a WA holds no roster row — and a WA on the team is already offered as a Work Item
  Owner, because `listProjectMemberOptions`' team branch reads `team_members` and applies no admin
  filter. The SPA was the only thing withholding them: `project-teams-tab.tsx` filtered
  `roleSlug !== 'workspace_admin'` out of the Team Lead options and the member table.

## Dev Owner is a SECOND responsibility, on a Task as well as a Story

`work_items.dev_owner_id` has existed since Phase 3.4; `work.tasks.dev_owner_id` arrived with
migration 0127, and until then the API ACCEPTED a `devOwnerId` on a task and dropped it silently —
the worst of the three possible behaviours. BA `c42df59` (2026-08-22) makes the field first-class:
`P2-BL-FR-012A`, `P2-IS-FR-032B`, `WID-FR-016` and `P4-NOTIF-DC-012`.

- **Rally has NO Dev Owner field at all** — not on a Task, not on a User Story (verified against
  Broadcom's own field references). One `Owner` per artifact, and a second responsibility would be a
  CUSTOM field there. So there is no parity to check here: the BA's spec IS the design.
- **Same candidate source as Owner, independent persistence.** Both fields read
  `assignmentCandidates` and both are validated by `assertAssignable`; a Dev Owner patch never
  writes `assigneeId`, which is the one thing the BA states twice ("must not reuse or overwrite").
- **`P4-NOTIF-DC-012` covers BOTH fields and Tasks**, so `notifyAssignment` takes the recipient rather
  than reading `item.assigneeId`, and the update path loops the two fields through one rule — a third
  responsibility later cannot pick up half the behaviour, which is how Dev Owner came to notify
  nobody. The RECIPIENT is the notification's discriminator, so one patch naming the same person as
  both Owner and Dev Owner tells them once.
- **Sorting by owner or Dev Owner is NOT implemented**, though the BA lists both in `sortBy`. The
  grids are keyset-paginated on `(column, id)` and a name lives on a JOINED table, so sorting by it
  means name-based keyset sorting for both fields — its own change. The alternative, sorting by the
  uuid, is what `COLUMN_SORT_FIELD`'s own comment already refuses.
- **`work.tasks` has no `dev_owner_id` FK**, matching `assignee_id` beside it: eligibility depends on
  the project AND the team, which no constraint can express, and a user delete must not cascade into
  delivery history.

## Feeds: one rule, and the five incidents behind it

**When a picker and a write path disagree, the WRITE is the contract.** A feed narrower than the
write it feeds makes half a documented rule unreachable, and it never presents as a feed bug — it
presents as a permission fault, a failed save, or a broken search. Two corollaries, both earned:

- **An OFFER list and a NAME source are two different feeds.** Offers narrow on purpose; names must
  not. `item.assigneeName ?? map lookup` — prefer the row, keep the feed as fallback. Widening an
  offer list to name someone is forbidden (`WID-FR-016`/AC-16).
- **Scope a feed per ROW, never per screen.** The row knows its team; the screen does not.

Read a picker's emptiness as a question about its FEED before touching the control: `SearchableSelect`
filters the options it was handed, so a missing option and a broken search are the same fault twice.

### The ONE eligibility rule (Owner and Dev Owner)

`ProjectsService.assignmentCandidates` is the only expression of it, read by the picker feed
(`listProjectMemberOptions`) and by the write (`assertAssignable`, `WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE`).
BA `c42df59` (2026-08-22) states it once and points both fields at it — `WID-FR-017`, `WIC-FR-006A`,
and the Project/Team assignment addendum:

| selected Team | offered |
|---|---|
| a Team | project `admin` (project-wide) + `editor` assigned to THAT team + Workspace Admin on its roster |
| none | project `admin` + Workspace Admin |

- **It replaced two visible defects.** The team branch read `team_members` ALONE, withholding a
  project Admin not on the team even though §3.1 gives Admin All Teams. The project-wide branch
  offered every member, so with no Team an Editor could be made Owner of work their own team scope
  would then refuse them.
- **The WRITE now applies it too.** It used to check only `assertWorkspaceMember` — orders of
  magnitude wider — so any user id in the body was accepted for work no picker would have offered.
  `reporterId` is deliberately OUTSIDE the rule: a reporter records who raised the item.
- **The no-Team branch including Workspace Admins is a DECLARED READING.** `WIC-FR-006A` says "with
  blank Team, Editor/WA **Team members** are not offered", which reads as excluding the team-derived
  qualification rather than the principal — and team-less work IS the Project Backlog, whose audience
  the team-scope ruling already fixes at Workspace Admin plus Project Admin. If the BA means the
  narrow reading, drop the second half of that branch and nothing else changes.
- **A fixture that assigns an owner needs a Team** (or an admin). Four e2e specs had to change, and
  that is the rule working: `manage-filters`, `notification-flow`, `team-status-relation-render` and
  `project-delivery-flow` were all assigning an Editor to team-less work.

### Owner defaults to the CURRENT USER when the feed offers them

`WIC-FR-006` reversed `GAP-P1-WID-007`/P6-TC-007's "default to Unassigned" (`P1-WID-01` agrees). **The eligibility gate is
what makes the reversal safe:** the old defect seeded the creator UNCONDITIONALLY, so work arrived
owned by whoever opened the form and a Task inherited it — also the upstream cause of
`GAP-P3-TS-008`'s off-roster member group in Team Status. A surface that defaults an Owner without
asking its own candidate feed re-creates the defect rather than following the rule.

The default is DERIVED, never stored — writing it into state cascades renders, and it must follow
every Team change. `useDefaultOwner` (`shared/lib/hooks/use-default-owner.ts`) is the ONE
implementation, because four create surfaces answered this four ways: two defaulted to nothing, and
one wrote `ownerId || <default>` — where `Unassigned` is `''` and therefore falsy, so an explicitly
cleared Owner was handed straight back and the field could not be cleared at all. It tracks the
CHOICE, never the value. A create form asks the hook; it does not re-derive the rule.

Five incidents produced this rule — empty Iteration Status dropdowns, assigned items reading
`No Entry`, a Story with a Team offering only `Unassigned` (`GAP-P1-WID-007`), no Defect able to
name its Parent Story, and the iteration lifecycle/scope case (`P6-VEL-004`). Each with its
root cause and the test that pins it: [`docs/lessons/feeds.md`](docs/lessons/feeds.md)

## A row's VERB needs a row affordance

`P2-BL-FR-022` and Phase 2/01 §124 put Delete on the row — "Delete Defect | Row or detail action with
confirmation" — and the Backlog had neither for most of its life. The BA logged "cannot delete work
item in Backlog" twice, and both times the route was innocent
(`test/e2e/work-item-delete-route.e2e.spec.ts` deletes a story, a task and a story-with-children over
HTTP).

- **The bulk bar is not a row action.** It only appears once rows are SELECTED, so a reader looking at
  one row sees no verb at all. That is why the first investigation of this report fixed the bulk
  control's gate and its error text and the report came back.
- **`WorkItemRowActions` is the shared control**, not page-local: the same action belongs on Quality
  and Iteration Status when the BA rules on those grids, and a second copy is how two grids come to
  confirm differently. It renders NOTHING without `work_item:delete` — the menu holds one verb, so a
  disabled item would be a menu that only refuses.
- **It is a TRAILING cell, not a declared column.** An affordance must not be resizable, reorderable
  or — the reason that matters — HIDEABLE, since hiding it would take away the row's only verb.
  Revealed on `group-hover` like the drag grip AND on `focus-within`, or a keyboard reader could tab
  to a control they cannot see.
- **The confirmation is NAMED, not typed, and its copy says what survives.** The delete is soft and
  `P3-QA-FR-020` retains the child Tasks, attachments, comments and relations, so "this cannot be
  undone" was false; the typed gate stays reserved for the irreversible.

## A chevron must move in the direction its ICON points, not by index

`Track > Iteration Status`' iteration arrows were reversed: from KB Sprint 1 the LEFT chevron
advanced to KB Sprint 2 (Production, 2026-08-21). The handlers were `index - 1` and `index + 1`, and
the feed is ordered **newest first** (`desc(startDate)` server-side; `default-iteration.ts` says the
picker "shows newest first"), so `- 1` is the LATER sprint.

- **The signature was the fix, not the arithmetic.** `stepIndexInTime(index, 'earlier' | 'later',
  count)` names the direction IN TIME, so a caller cannot express "left" without saying what left
  means, and a later change to the feed's order breaks one tested expression instead of silently
  reversing two buttons.
- **The disabled state must come from the same mapping.** Both chevrons' `disabled`, cursor, colour
  and hover were computed from raw index comparisons *in the styling*, which is how a greyed-out arrow
  and the step it guards can disagree about which end of the list they are at. They read `hasEarlier`
  / `hasLater`, both derived from `stepIndexInTime`.
- The arrows had **no test at all**, which is why a newest-first feed reversed them unnoticed. They
  also had no accessible name; they are `Previous iteration` / `Next iteration` now.

## Shared chrome: a layer rule, a width rule, and what a table actually is

One layer rule, one width rule, and a definition of "table" that the shared primitives enforce. Read
before adding a grid, a modal layer or a column.

Full account — every invariant with the incident that produced it: [`docs/lessons/shared-chrome.md`](docs/lessons/shared-chrome.md)

## A parent's Schedule State is DERIVED FROM ITS TASK SET, not nudged by transitions

Rally's own rule (Broadcom, "Task State Updates Parent Schedule State"), and now ours —
`reconcileParentScheduleState` in `WorkItemsService`, called from task create, update and delete:

| the live task set | parent becomes |
|---|---|
| all `Defined` | `Defined` |
| all `Completed` | `Completed` |
| anything else | `In-Progress` |
| no live tasks | untouched — nothing to derive from |

**It was three per-event branches, and that shape is what broke it.** `TASK-FR-016` states two triggers
(all Tasks Completed; any Task reopened) and both were built; a Task STARTING was cited in the service's
own comment as Rally's behaviour ("otherwise → In Progress") and never implemented. So a Story read
`Defined` while a Task under it was In-Progress — a state Rally cannot be in, and the first thing a
reader checks to answer "is anyone working on this?". Reported from develop on 2026-08-22 as "the
roll-up stopped working"; it had never worked for that trigger, which is why nothing regressed and no
test caught it. A set-derived rule has no third trigger to forget.

- **CREATE and DELETE are part of the rule**, and no transition trigger could ever have covered them.
  Broadcom names both: "adding a task to a story in Idea will make the story Defined" and "adding a
  task to a story in Completed will make the story In Progress". Deleting the last OPEN task completes
  the parent exactly as completing it would have.
- **`accepted` and `release` are reconciled like any other state, and guarding them would have been the
  natural mistake.** Broadcom is silent on those two, so the literal rule un-accepts a Story because
  somebody added a Task — which reads like something to prevent. The repo had already decided it:
  `P3-TS-FR-041` (BA-confirmed 2026-07-24) moves a parent back "from ANY at-or-past-completed state —
  `completed`, `accepted` OR `release`", with a unit test asserting it. A guard here would have
  contradicted a confirmed rule and its own test. To reverse it, exempt those states in the reconciler
  and retire that case — both, or the two disagree.
- **`taskStateCounts` replaced `areAllTasksComplete`** for the same reason: "are they all complete"
  cannot answer two of the three cases, so the port returns a census.
- **The one divergence from Rally: we have no `Auto State Updates` switch.** Rally gates this whole
  behaviour per project/subscription, which is how it reconciles automation with `TASK-FR-016`'s "user
  may still change the parent status manually". Without it a manual parent state survives only until
  the next task write. Put to the BA; if they want the manual edit to win, that switch is the answer,
  not weakening the rule.
- Reached by every surface: the three SPA controls (Tasks tab, Iteration Status nested row, Team Status)
  all send `PATCH /v1/work-items/:id`, and Team Status' own task route delegates to this service. Pinned
  in `test/e2e/derived-invariants.e2e.spec.ts`, which asserts the STORED parent state — what every grid,
  report and burndown reads — not the response of the call that changed the Task.

## Task hours are THREE independent fields

`Estimate`, `To Do` and `Actual` never derive from each other (Portfolio SRS:141-147), with exactly
two automatic moves:

- **The FIRST Estimate copies itself to To Do, once** — and only while To Do is `null`. `0` is not
  "unset": a completed task has exactly that, so re-copying would undo the auto-zero below or
  overwrite a planner who typed 0 deliberately. The create path always did this; the update path did
  not, so estimating an existing task left To Do empty and the number had to be typed twice.
- **Completing a task sets To Do to 0**, and **reopening does NOT restore it** — the owner enters a new
  remaining value if there is one. This replaces the older `Estimate = To Do + Actual` display rule.

## A Task's Iteration is DERIVED, not cascaded

The BA says it three times — "A Task inherits Project, Team, Iteration and Release/Milestone context
THROUGH ITS PARENT Story/Defect" (`BUSINESS_BASELINE.md`), "no independent Iteration selector"
(`P1-TASK-011`), "without an independent Task iteration assignment" (`P2-IS-024`) — and real Rally
shows the field read-only. That is stronger than keeping two values in step: **a Task owns no
iteration value at all.**

- **`work.tasks.iteration_id` is a maintained mirror** (`trg_task_iteration_from_parent`, migration
  0095). It is re-read from `parent_id` on every insert and on any update touching `parent_id` or
  `iteration_id`, so reparenting follows the new parent for free and a raw-SQL write cannot diverge.
  Enforced in the DB because `db/seeds/**` writes `work.tasks` directly — the same reason
  `trg_sync_accepted_date` and `timebox_group_id` are triggers.
- **Moving a parent moves its Tasks** (`trg_cascade_iteration_to_tasks`, `AFTER UPDATE OF
iteration_id`). Before this, `createTask` inherited once at birth and nothing looked at the parent
  again, so a moved Story left its Tasks counting hours in the old sprint.
- **Passing an iteration for a Task is a REFUSAL** (`TASK_ITERATION_DERIVED`), not a silent
  discard — and on `createTask` it is a compile error, because the opts type no longer has the field.
  `CreateTaskSchema` dropped it too, so the contract does not advertise what the service refuses. The
  guard sits in `createWorkItem` as well: `POST /work-items` with `type: 'task'` skips the
  `createTask` wrapper entirely.
- **`teamId` is NOT derived.** A Task's team only DEFAULTS to its parent's and stays settable (SRS
  P1-04); `getScopedTaskHours` resolves `coalesce(task, parent, iteration)` deliberately. Only the
  Iteration is contractually derived.

## The archive is a place, and deleting from it is guarded

Archiving used to be a ONE-WAY DOOR with no room behind it. `GET /projects/:id/teams` narrows to
`teams.status = 'active'` deliberately (so no picker offers an archived team), and that was the only
teams feed the SPA used — so an archived team was invisible everywhere, including the Teams tab that
renders a Status column and a Restore action for it. Archived PROJECTS were better off: the list query
never filtered status, so only `listHealthByWorkspace` (the Home widget, correctly) hides them.

- **`DELETE /teams/:id` exists now, and refuses twice.** `TEAM_NOT_ARCHIVED` — delete is an operation on
  the archive, so the destructive step is always preceded by a reversible one that already removed the
  team from every picker. `TEAM_HAS_HISTORY` — and it NAMES the sources and counts, because "you cannot
  delete this" without saying what holds it is a dead end, and the holder is usually something the admin
  can move.
- **The guard is not belt-and-braces over a database constraint; it is the ONLY thing standing there.**
  `work_items.team_id`, `tasks.team_id`, `iterations.team_id` and `portfolio_items.team_id` carry **no
  foreign key** to `teams`, so a delete leaves them pointing at a row that is gone — silently, since
  every reader resolves the team name by join and simply renders nothing. The columns that DO have one
  are worse in the other direction: `member_capacity`, `iteration_daily_snapshots`,
  `iteration_team_baselines` and `release_team_targets` are `ON DELETE CASCADE`, so Postgres would
  accept the delete and take frozen report history with it. That is exactly what §488 exists to stop, so
  the rule is delete ONLY when there is nothing to destroy — §488 kept, rather than traded away.
- **`team_members` and `project_teams` are CLEANED, not counted.** They describe the team rather than
  delivery history, and they have no foreign key either — so `deleteTeam` removes them in the same
  transaction or `listByTeam` would keep returning members of a team that no longer exists.
- **Deleting drops the roster's permission cache.** RBE-06 grants project access FROM a roster row, so
  those users' cached assignments are stale the moment the team stops existing. The roster is read
  BEFORE the delete, or there is nothing left to read.
- **A project delete from the archive is a DECLARED DIVERGENCE from `P0-PRJ-008`**, which says an
  archived project offers Restore ONLY. The product owner asked for delete on 2026-08-20 and it reuses
  the existing soft delete (`deleted_at`), so it is reversible in the database and invisible in the app.
  Teams have no soft delete, which is why their rule is the strict one above.

## An archived Team keeps its hours

"Archive Team does not delete the linked Work Item/Sprint history" (DB design §488), so Team Capacity
still reports an archived team's rows — a total that shrinks when a team is disbanded is worse than
one that explains itself. The row carries `archived: true` and renders `TEAM_STATUS_STYLE.archived`,
because the global Team picker hides archived teams and nothing else on screen would say the team no
longer exists. The flag is ORed across the capacity rows and the task rows: both reach the same
bucket, and a task row whose `teams` join missed must not clear what a capacity row set correctly.

**That sentence used to credit the wrong filter, and the difference was a live defect.** It said the
picker hides them "because `app-shell.tsx` filters `status === 'active'`" — but the status on those
rows is `project_teams.status`, the LINK's status, projected over the joined `teams` row. So the
client filter only ever dropped UNLINKED links, and an archived-but-still-linked team was offered
everywhere that feed reaches: every team picker, and the Capacity plan's Add Team dialog, whose write
path requires both statuses and answers `CAPACITY_TEAM_NOT_FOUND`. That is the "another eligible Team
cannot be added" half of P5-CP-006 — a picker offering what the server refuses. The predicate now
lives in `ProjectTeamDrizzleRepository` (`eq(teams.status, 'active')`, and an inner join, since a NULL
team can no longer satisfy it), so the claim is true server-side and both callers get the narrower
set. Narrowing the shared query rather than adding a parameter is deliberate: `projectTeamContext`'s
own docblock requires the server to count exactly the population the picker offers. **Read a
`status` column twice before trusting it — a join can project a link's status where a row's status
is what the sentence means.**

## A rule stated as an INVARIANT cannot be implemented as one write's hook

Two BA rules were specified as conditions and built as hooks on one particular write, so a different
write reaching the same state left the rule unsatisfied. Both are now pinned by
`test/e2e/derived-invariants.e2e.spec.ts`.

- **Iteration auto-accept is a condition over MEMBERSHIP**: "a non-empty Iteration auto-changes to
  `Accepted` when all ASSIGNED Story/Defect items are `Accepted`" (BUSINESS_BASELINE:12, BR-IT-02) —
  and *assigned* is what a scope change alters. The check only ran on a `scheduleState` transition, so
  moving the last open Story OUT, or bulk-assigning an accepted Story IN, left the iteration Committed
  while the Iteration Status tile read ACCEPTED 100%. Every membership write now re-evaluates BOTH
  affected iterations (the one left and the one joined). Safe to run on every move because
  `autoAcceptIterationIfComplete` only ever goes `planning|committed → accepted` — the same rule's
  "does not auto-reverse" clause is what makes that true.
- **A Milestone's target window EQUALS its linked Releases' MIN/MAX** (P3-MS-FR-011/012, §73).
  `recalcTargetDates` ran on create, update, link writes — and on `getMilestone`, a repair on the READ
  path. It never ran when a linked Release's own dates were edited, and `listMilestones` reads the
  persisted columns, so the detail page self-healed while the list showed a stale window. **The
  self-healing is why it hid**: the surface a reviewer opens was the one that repaired itself.
  Migration 0097 moves this to triggers covering all three invalidating writes (a release date edit, a
  link add/remove, a manual write to a linked milestone, which §73 makes read-only), and the read-path
  repair is gone. `§75` is respected: removing the last link leaves the dates alone rather than
  inferring NULL.

**The smell to watch for: a value repaired on read.** It makes the defect invisible on exactly the
screen someone checks, and it leaves every other reader stale.

**Its sibling: a value HIDDEN on read.** Migration 0118 deletes the Workspace Admin's
`project_members` rows (§2.1/AC-8), and `db/seeds/demo.ts` wrote the same row straight back — and
`pnpm db:migrate` runs that seed, so every local and CI database undid the migration on the spot. What
made it invisible is that the fix's own three readers (the roster query, `memberCount`, and the POST
refusal) all correctly hide such a row, so nothing on screen would ever have shown it coming back. It
was not cosmetic either: `AccessService.effectiveAssignments` synthesizes a project grant FROM that
table, so the row is dormant only while the user is a WA — demote them and it becomes a live Project
Admin grant no roster displays. **Whenever a migration DELETES rows, grep `db/seeds/**` for the writer
before assuming the deletion holds.**

**And a third: state FROZEN before its source arrived.** The user-access modal's draft materialised
`teamIds` from its baseline the moment any part of a row was edited, but team memberships come from
their own query — so choosing `Editor` before `/v1/teams/{id}/members` resolved froze `[]` in, and a
draft SHADOWS the baseline, so the real memberships could never reach it. §2.2's "an Editor needs a
Team" guard then stayed true forever: `Review Changes` disabled permanently, the user's own team
unchecked, no way out but closing the modal. **A draft must hold only what the user TOUCHED** —
`undefined` meaning "resolve against the baseline when it arrives", the same absent-versus-empty
distinction a capacity plan's window and an allocation's value already rely on. Diagnosis note, because
it presented as a flaky test (2 runs in 8): raising the `waitFor` timeout to 5s did NOT help, and that
is what proves frozen state rather than a slow render. Pin such a case with a DEFERRED promise so the
ordering is deterministic instead of lucky.

## Archive ordering cuts both ways

An Epic with active child Features cannot be archived — and a Feature whose Epic is archived cannot be
RESTORED (`PORTFOLIO_PARENT_ARCHIVED`). The second half was missing, so the forbidden state was
reachable in three legal steps: archive the Feature, archive the now-childless Epic, restore the
Feature. That leaves an active Feature under a hidden parent, which is what `assertReferences` refuses
on every other write. The message names the Epic's key, because an archived parent is invisible in
every list.

## A record's Project is chosen ONCE, by the context, and never again

Settled on the BA's 2026-08-17 retest of **P5-PI-003**, and it applies to every type at once:
`WIC-FR-004` AC #11 ("Project cannot be changed in Quick Create, Create with details, **or any reused
modal**"), `WID-FR-017` AC #9 ("moving between Projects unsupported"), Task Management AC #14 (a
Task's Project equals its parent's), and P5 §4 / §45 / §339 for a Feature and an Epic. So the Project
field is an auto-filled, read-only display on every create surface, and to create elsewhere the user
changes the **global Project context** first.

- **There is no editable project cell or field anywhere in the SPA.** `ProjectSelectCell` is
  DELETED, not gated — `shared/ui/project-cell.tsx` exports only the read-only `ProjectCell`, and
  the `ProjectOption` shape went with it. A `canEdit={false}` prop is one prop away from `true`, and
  there is no role or surface for which the move is legal, so "read-only" is a property of the
  component rather than of a caller's argument. Same reasoning as `createTask`'s iteration field
  being a compile error rather than a runtime refusal.
- **This REVERSES the previous answer to the same BA case, which is why it is recorded.** P5-PI-003
  first read as "selecting AUDIT26 returns an unexpected error", and the fix was to NARROW the
  Portfolio grid's move picker to unarchived projects the caller held `portfolio:edit` on
  (`updateItem` authorises a move in both directions). That was a correct reading of a wrong
  question: the BA's answer is that there is no picker. `portfolio-page.test.tsx` used to assert the
  narrowed option list and now asserts the absence of the control — a test inverted, not deleted.
- **The SERVER refuses it too, and this note used to say the opposite.** It first shipped as a display
  rule, on the reading that the report scoped itself to "FE và business behavior". That reading was
  wrong by one word: a server refusal is not a schema or DB change, it is business behavior, which
  that same sentence includes — and rule 4 of the report says the move "is not supported" flatly.
  `UpdatePortfolioItemSchema` no longer carries `projectId`, so the contract does not advertise what
  is refused, and `updateItem` answers `PORTFOLIO_ITEM_PROJECT_IMMUTABLE` for a different project
  while treating the SAME project as a no-op (a client echoing the record back is not refused for
  agreeing). `applyProjectMove` is DELETED with it: the destination-team reset, the Release clear, the
  cross-project Epic unlink and the surviving-Milestone filter existed only for that write, and the
  spec's `innerJoin` + `selectDistinct` mock chains went with them rather than standing as scaffolding
  for a call nobody makes.

  **`PORTFOLIO_ITEM_HAS_CAPACITY_ALLOCATION` did NOT go with it** — that rule also guards the
  allocate side, and it now lives only where the capacity module enforces it.

  Real Rally DOES offer this move (Broadcom's project-hierarchy guide: "Rally recommends you update
  the project field to reflect which team is handling the work"), so this is a **declared divergence**,
  recorded on `UpdatePortfolioItemSchema` as well. If the BA reverses it, the field, the guard and
  `applyProjectMove` all come back together — a picker without the reconciliation would leave a Team
  and a Release pointing into the old project.
- **There is NO exception left — Iteration create used to be one, and the BA closed it.** This note
  read "the ONE Project picker that stays is on Iteration create", on §92-93's sentence that a
  Workspace Admin "vẫn có quyền đổi Project/Team trong quick create/detail nếu cần". BA `c42df59`
  rewrites that row: `P2-IT-FR-011` lists the quick-create field as a "read-only Project" and
  `P2-IT-FR-001D` says a Workspace Admin/Admin "cannot change Iteration Project inside create/detail.
  To create in another Project, change the global Project context first." So the picker is DELETED
  rather than disabled, and the detail panel's `ProjectCell` was already right. `UpdateIterationSchema`
  never carried `projectId`, and that absence is now documented on the schema so it is not helpfully
  filled in. **The second sentence of FR-001D still stands**: Team may be changed, "only to a Team
  valid for the fixed Project" — which is why the Team picker is scoped to `projectId` and
  `assertTeamInProject` is the enforcement.
- **`ReadOnlyFieldValue` (`shared/ui/form-field.tsx`) is the box these render in** — an input-shaped
  `<div>`, deliberately not a `disabled` input, so the fixed value sits on the same baseline as the
  editable fields beside it without announcing itself as a control that might become enabled. It
  takes no `onChange` by design. Three surfaces had hand-rolled its class string.

## Declared divergences from the BA, in Capacity Planning

Publishing is **ONE decision per FEATURE** and the Release rule is EQUALITY; an allocation's value is a
**FIXED SNAPSHOT with a source label**, never recomputed on read.

Full account — every invariant with the incident that produced it: [`docs/lessons/capacity-planning.md`](docs/lessons/capacity-planning.md)

## Publishing a plan is ONE decision per FEATURE, and the Release rule is EQUALITY

Both halves were `P5-CP-035` (retest 2026-08-17, Confirmed Partial, P1), and both are easy to
reintroduce because the natural thing to iterate is `listAllocations`.

- **A split Feature has N allocation rows and ONE publish decision.** Same window, same Release answer,
  same advisory. Looping the rows wrote the Feature N times (churning `updated_at`) and pushed its
  advisory N times, which reads as N separate problems — and gave the SPA a duplicate React key.
  `publishTargets` folds the rows to unique Features BEFORE anything is written or reported, and
  `unallocated` becomes an OR over the Feature's rows, so a Feature holding one team row and one parked
  row is assigned rather than both updated AND reported as having no team.
- **`windowsMatch` is EQUALITY on both ends, never containment.** AC-019 says the Release field is
  written "only when the Plan planned start/end dates MATCH the selected Release start/end dates", and
  the consequence is the bit that bites the COPY: a plan ending EARLIER than its release fails the check
  while being nowhere near outside it. The old advisory said "the plan's window reaches outside its
  release", which is a fault the planner cannot find. It now names both windows —
  `Plan dates X to Y do not exactly match Release dates A to B. Planned dates were updated; Release was
not changed.` — and the pre-publish modal says "exactly match" rather than "falls inside".
  Both sides are normalised to date-only first (`dateOnly`), so the comparison can never silently become
  a timestamp one with timezone as the invisible variable.

The release dates in that advisory come from the release REFERENCE feed in the SPA
(`useReleaseOptions`), not from the publish response: the reason code is the server's contract, and a
second server field for two dates the client already holds would be one more number free to disagree
with the plan header beside it.

## An allocation's value is a FIXED SNAPSHOT with a source label

`capacity_plan_allocations.value` is NOT NULL and carries `source` (`feature_estimate` | `manual`),
which is migration 0101 reversing 0077 on purpose. Anything that reads or writes an allocation must
respect this:

- **Never resolve an allocation's charge on read.** SRS §11 is `fixed allocation.value set during
  planning/replanning`, and §337 defines Team Estimated as `SUM(allocation.value)`. 0077 had made the
  column nullable so a blank Estimate could resolve to the Feature's own estimate per request. That
  meant editing a Feature's Refined Estimate silently moved every Draft plan that had assigned it — a
  planner's committed demand changed with no action on the plan — and no surface could compute a total
  from the stored rows, so five of them re-resolved and agreed by luck.
- **`source` is why the value can be fixed.** 0077's stated objection was real: "a defaulted 8 and a
  deliberate 8 were indistinguishable." The BA answers it with a label, not a null (§185: blank
  "copies the Feature's top-down estimate into a fixed allocation row and labels its source `Feature
  Estimate`"; §186: a supplied one "becomes a fixed `Manual` allocation row").
- **The copy happens at WRITE time, in the plan's unit** — `defaultAllocationEstimate`, Refined →
  Preliminary, deliberately skipping Total Allocated so a blank field cannot commit the sum of the
  allocations it is creating (§294). `value: null` on a PATCH means RE-COPY, not clear: the emptied
  cell re-baselines the row against the Feature's forecast as it stands now.
- **A tier is a property of a FEATURE, not of an allocation row.** AC-014 resolves Feature Estimated
  from Total Allocated (team-assigned rows only) → Refined → Preliminary, once, over the aggregate.
  Allocation rows have a `source`; only item rows have a `tier`.
- **A merged parked row keeps its source only when exactly ONE row folded in.** A sum of two rows is a
  number no single rule produced, so it is `manual` — calling it a Feature estimate would misreport
  the Feature's size.

## Capacity: what refuses, and why

Three references into a capacity plan are now REFUSALS rather than silent repairs, all following
`RELEASE_HAS_CAPACITY_PLAN` on release delete — the pattern this repo already chose:

- **Moving a Feature to another project** while it is allocated
  (`PORTFOLIO_ITEM_HAS_CAPACITY_ALLOCATION`). A plan belongs to one project, so the Feature took
  nothing with it: the rows stayed behind, kept feeding that team's Estimated, the plan total and
  the cutline, and publish wrote the OLD project's Release onto it — the state `assertReferences`
  itself rejects. Deleting the rows instead would destroy committed numbers on a plan the person
  moving the Feature may not even be able to see. `applyPlanToFeature` also filters on the plan's
  project now, so the write is incapable of crossing projects even for rows that predate the guard.
- **Unlinking a team from a project** while it sits on one of that project's plans
  (`PROJECT_TEAM_HAS_CAPACITY_PLAN`). `project_teams` is a soft status flip, so
  `fk_capacity_plan_teams_team ON DELETE RESTRICT` never fires. `Remove Team` on the plan is the
  deliberate action and it re-parks the demand (AC-005), so the refusal costs nothing.
- **`assertTeamInProject` requires both the LINK and the TEAM to be active.** It checked neither, so
  an unlinked or archived team could still be added to a plan — recreating exactly what migration
  0085 was written to clean up.

**`capacity:view_draft` is the fourth capacity code, and it is now REDUNDANT — the requirement it
existed for is gone.** It was added because AC-012 was read as keeping a read-only Project Admin
"opening Draft and Published plans", which `capacity:manage || capacity:publish` could not express.
That reading is STALE: on `product-docs` `origin/main`, `P5-CAP-AC-012` says Capacity Planning "uses the
fixed Phase 4 Project Access baseline and has **no temporary editable Full/View permission row**",
`P5-CAP-AC-010` says "Editor/No Access do not access Capacity Planning", and `P5-CAP-AC-013` is marked
N/A with "Viewer level removed". So there is no read-only planner, and every role holding
`capacity:view_draft` (`workspace_admin`, `project_admin`) also holds `capacity:manage` — the code
cannot distinguish anyone. It is still granted and still read, deliberately: retiring a permission that
sits in live role arrays needs a migration, not a catalogue edit, and the BA has been asked to confirm
no future read-only planner is intended. Backfilled by migration 0094.

**The lesson worth more than the fact:** this note asserted an AC that the BA had since changed, and two
e2e tests were built on it — constructing a read-only planner from a CUSTOM ROLE, pinning a shape the
SRS had deleted. Read `product-docs` `origin/main` rather than a summary of it before building on an AC;
the local checkout is a gap-audit branch and lags where the BA authors.

## An invitation binds to an ADDRESS, and grants a real role

Two independent faults on the one flow that onboards every user, both fixed together:

- **Acceptance is bound to the invited email.** It used to validate only `pending` + not-expired, so
  the token was a bearer capability — a forwarded link, a shared inbox or a copied URL made the wrong
  person a member at the invited role (`INVITATION_EMAIL_MISMATCH` now refuses it, case-insensitively,
  because an IdP may return a differently-cased local part for the same mailbox).
- **`workspace_members.role_id` is authoritative for NOTHING.** `AccessService` resolves permissions
  from `user_role_assignments`, and this module's own members query reads the role from there too.
  `addMember` writes only the denormalised column, so the invited role was written where nobody reads
  it: a user invited as Project Admin landed with whatever `ensureDefaultRole` gives a first SSO
  login, and the admin who sent the invitation saw the intended role nowhere. Accept now calls
  `grantWorkspaceRole` **inside the same transaction** and invalidates the permission cache after
  commit, like `assignRole` does. Any new path that "assigns a role" must write the assignment table.

**Who SENDS the invitation email depends on `ENTRA_GUEST_INVITE_ENABLED`, and that is the ordering an
external collaborator depends on.** `inviteMember` wrote both outbox rows in one transaction and two
independent relays drained them — the email relay every 5s AND woken instantly by `wakeEmailRelay`, the
Entra guest relay on a 30s cron with no wake signal at all. So the link arrived in under a second and
the invitee's guest object in our tenant up to 30s later, plus Microsoft's directory replication: an
invitee who clicks immediately cannot authenticate (`NO_CONNECTION` from our login box, `AADSTS50020`
from Microsoft's), intermittently, and it reads as the feature being broken. With the flag ON the email
is now scheduled by the ONE component that knows the guest is ready — `EntraGuestInviteRelayService`,
in the same transaction that marks the row `sent` and writes `entra_guest_object_id`. Flag OFF is
untouched: nothing is enqueued, `GuestInviteSchedulerService.schedule` answers `false`, and the email
goes out inline. Four consequences worth knowing before touching either half:

- **A permanent Graph refusal schedules NO email** (invalid address, `User.Invite.All` unconsented, B2B
  invitations disabled tenant-wide). The invitee cannot authenticate, so a link is a dead end that also
  burns the one-shot token; the dead-letter log and `last_error` are the signal. **The operator action is
  CANCEL AND RE-INVITE, not `Resend Invitation`** — resend reuses the same `idempotencyKey`
  (`invitation.id`) with `onConflictDoNothing`, so a row already at `status = 'failed'` is untouched and
  the guest is never re-provisioned; only a NEW invitation mints a new key. A benign `proxyAddresses`
  collision DOES email — that invitee is already a directory member.
- **The flag gates ENQUEUEING, not draining.** The relay used to skip polling entirely while the flag
  was off; now that a queued row also owes the email, that would strand the invitee in silence, so
  committed intents are always drained.
- **`guest_invite_outbox.invite_token` holds the RAW token** (migration 0124), because only its sha256
  is persisted and the relay could not otherwise build `inviteUrl`. Scrubbed in the same write that
  schedules the email, and on a terminal failure. NULL also *means* "this row owes no email", which is
  what `resendInvitation` passes — it mails its own rotated token inline.
- **Both writers key the email on `invitation.id`**, so a flag flipped mid-flight cannot produce two
  invitation emails; the relay additionally refuses to mail a token whose hash no longer matches the
  invitation, or an invitation that is no longer `pending`.

## A cross-project LIST is scoped by `listReadableProjectIds`, not by `workspace_id`

Full account — every invariant with the incident that produced it: [`docs/lessons/project-scoping.md`](docs/lessons/project-scoping.md)

## A PERSISTED selection outlives the grant it was made under

`app-context.store`'s `project` and `team` are zustand `persist` state, so a revoked project survives in
localStorage and every reader trusts it. `useInitialProject` is the ONE reconciler — it already replaced
a selection missing from `GET /v1/projects` **whenever some other project remained**, and returned early
when the list was empty, which is precisely the No Access principal the rule is about. So the shell's
context trigger kept printing `TEST · All Teams`, the breadcrumb kept naming the project, and every
project-scoped query kept being issued for it, while the nav, the Project list and `/backlog` were all
correctly empty or denied. Reconcile in that hook and nowhere else; a second copy of the rule is how the
header and the nav come to disagree.

Three properties of it are load-bearing and none is obvious:

- **The list is the authority.** `GET /v1/projects` is scoped by `listReadableProjectIds`, so a project
  absent from a **resolved** response is one the server will not serve. Clearing is the server's answer
  applied to client state, not a guess.
- **`undefined` decides nothing, in EITHER direction.** It is both "in flight" and "failed", so it must
  not invent a selection *and* must not clear a good one — a network blink would otherwise evict a
  reader from their own project.
- **Clearing the project clears the Team with it.** A Team belongs to the project being left, which is
  what the shell's own switcher and `adoptRecordProject` already do.

## Changing EITHER half of the delivery context lands on Home

`SHELL-FR-005`: "Khi đổi Project hoặc Team từ context selector, navigate về Home của context mới và
invalidate/refetch toàn bộ Project/Team-scoped query. Không giữ route hoặc dữ liệu của context cũ."
Both halves, one rule, in `selectProjectContext` (`widgets/app-shell/app-shell.tsx`).

- **A TEAM-only change navigates too, and this REVERSES the narrower reading shipped in #467** —
  that Team is merely a scope filter, so throwing the reader to Home would undo the narrowing they
  just asked for. The requirement admits no such exception, and the RECORD routes are why it wins: a
  work-item detail or an Iteration Status row belongs to the context it was opened under, so an
  Editor moving between their own teams would otherwise sit on a record their new scope refuses.
- **The invalidation is unconditional for both.** A team change used to drop `['work-items']` alone,
  which is narrower than the rule and narrower than the truth — iterations, capacity, reports, Team
  Status and every picker are team-scoped as well, so each kept serving the previous team's rows
  until its own staleness expired.
- Pinned by `apps/web/src/test/e2e/context-switch.e2e.ts`, which starts on `/backlog` so "landed on
  Home" cannot pass vacuously. The switcher had NO journey of its own before, which is how the Team
  half shipped with the opposite behaviour.

## A sort affordance must order by the value the cell RENDERS

Iteration Status offered one on Owner and compared `assigneeId` — a uuid — so the column sorted into
an order arbitrary to every reader, indistinguishable from a broken sort. Three separate faults, all
under `P2-IS-FR-025/026`, and each was invisible in a different way:

- **Owner sorted by uuid.** Fixed by comparing the joined `assigneeName`, which exists only because
  the read models now join the name (see "A NAME belongs to the ROW").
- **Dev Owner had no mapping AND no `sortCol`.** Its header was inert in both directions.
- **Flow State declared a `sortCol` with no case**, so it fell through to `return 0` and clicking it
  did nothing. It orders by `scheduleState`, the field its own cell reads and writes.

Two rules came out of it that apply to any grid:

- **Absent sorts LAST ascending, FIRST descending** — the same rule `keysetCondition` applies
  server-side, so a column sorted on the client and the same column sorted by the server cannot
  disagree about where blanks belong. Comparing a missing owner as `''` floats every unassigned row
  to the top of an A-Z sort, and an unestimated row ranks as a deliberate zero.
- **Iteration Status sorts on the CLIENT deliberately.** `useIterationStatus` follows the cursor and
  loads the whole iteration (the Board view needs every row for drag), so the set is complete and a
  server `sortBy` would be a second definition of one ordering — §286 lists the param, but the grid
  it describes does not page. The Backlog is the opposite case and sorts server-side, which is why
  `keysetCondition` grew an expression overload: `assignee` / `devOwner` seek on the same
  `coalesce(display_name, email)` the cell renders, so the order and its own cursor cannot diverge
  on a user with no display name. `iteration` stays unsortable on the Backlog (every row there is
  unscheduled, so it could only be a no-op) and `release` needs a join that query does not carry.

## A RECORD route must own its denied state; its guard cannot

`RequirePermission` resolves the code against the **selected** project, and renders its children when
that read itself fails ("we could not ask" is not "you may not"). `/item/$itemKey` resolves a
workspace-unique key, so `GET /work-items/by-key` deliberately carries no `@RequirePermission` and
asserts `work_item:view` on the row's own project after loading it — meaning the refusal that matters
arrives at the PAGE, as a 403, on a project the guard never consulted. With the page's only non-record
branch a "not found" line, `/item/US-17` rendered a BLANK page for a reader with no access: no statement,
no recovery action, one URL away from a `/backlog` that gets it right (Phase 4 §7).

Two things fell out of fixing it that generalise:

- **A query that throws `new Error(apiErrorMessage(...))` discards the status**, so a page cannot tell a
  403 from a 500 and `queryClient`'s own `retry` predicate — which reads `error.status` to stop retrying
  4xx — saw `undefined` and retried refusals. `ApiError` carries it; throw that wherever a surface
  branches on the outcome.
- **Three outcomes, three sentences**: `AccessDenied` (403), the key named back (a 404 mapped to
  `null`), `LoadErrorState` (anything else). A status we cannot read is a load failure, NEVER a refusal.

## A route's permission code must be one the intended role can hold

`GET /work-items/by-key` carried `workspace:view` — admin-only, since `workspace:*` is
admin-reserved and neither Project Admin nor Project Member holds any `workspace:*` code. It is the
sole resolver behind `/item/$itemKey`, so **every notification click and ID cell 403'd for both
non-admin roles** while the service's own `assertProjectPermission(work_item:view)` would have allowed
them. It now carries no decorator, deliberately: item keys are workspace-unique so the owning project
is unknown until the row loads, which is the same resolve-then-check shape as
`PATCH /work-items/reorder`. Same class of bug: `POST /iterations/:id/work-items` required
`iteration:edit` while the Add New button was gated on `work_item:create`, so a Project Member saw the
button and got a 403 for an item they can create from the Backlog.

**The pattern to watch for:** a gate chosen for where the id lives rather than for what the action is.
It is invisible in testing because the dev principal is a Workspace Admin whose `workspace:*` masks
every one of them — exactly how the `report:view` bug survived to migration 0092.

## Declared divergences from the BA, in the access model

The permission catalogue is the single source of truth; **custom roles and the editable permission
matrix are DELETED** (ruling 2026-08-14) and the read-only Permission Model tab is an AC-11 requirement.
**There is NO `Viewer` level**, and **a per-Project `Admin` has NO structural authority.**

Full account — every invariant with the incident that produced it: [`docs/lessons/access-model.md`](docs/lessons/access-model.md)

## Permissions reach a workspace ONCE

`db/permissions.catalog.ts` is the source of truth, but `db/seeds/bootstrap.ts` upserts the
per-workspace tier roles with `set: { name }` — deliberately, so re-seeding cannot clobber an
admin's edits to a role's permissions. The consequence is easy to miss: **a permission added to
the catalogue never reaches an existing workspace.** Phase 6 added `report:view` to
PROJECT_ADMIN and PROJECT_MEMBER and every pre-Phase-6 workspace kept its old array, so all five
report routes answered 403 to everyone except Workspace Admin — whose `workspace:*` grant is the
global anchor and hid the fault everywhere it was tested. Migration 0092 backfills it.

So: **a new permission needs a backfill migration**, not just a catalogue entry. Force it only
when the permission is genuinely new (nobody can have revoked what never existed); a permission
that already shipped must be merged, not forced, or the migration undoes someone's decision.

**Custom roles and the editable permission matrix are DELETED** (ruling 2026-08-14). AC-11 makes the
Permission Model read-only with no editable matrix, and three things agreed: the editing UI was already
dead code (`RoleEditorDialog` unreferenced, `role-capabilities.ts` with no live consumer), the catalogue
above is the single source of truth so a customisable matrix forks it, and — the deciding reason —
custom-role CRUD plus workspace-scoped tier-role assignment together re-create exactly the company-wide
over-grant migration 0111 removed. The READ-ONLY Permission Model tab stays; it is an AC-11 requirement,
not a leftover.

**The removal is deliberately sequenced, because deleting a role a user HOLDS revokes their access:**
(1) remove the editing routes and dead UI — a contract change with no data risk; (2) a **dry-run report**
of every custom role, everyone holding one, and every workspace-scoped tier assignment (the
`pnpm db:backfill:accepted-date` shape: report, never guess); (3) only then a migration that removes
them, converting any real assignment to its per-project equivalent. Step 3 is gated on reading step 2's
output against a real database — do not collapse the three into one change.

## Seeds: what a DEPLOYED database is allowed to contain

Three tiers, and only the first two ever reach a deployed environment:

| tier | file | contents | where |
|---|---|---|---|
| reference | `db/seeds/reference.ts` | `access.system_roles` from `db/permissions.catalog.ts` | every env, every deploy |
| bootstrap | `db/seeds/bootstrap.ts` | workspace + Entra SSO + `workspace_settings` + workspace-owned tier roles | every env, every deploy |
| fixtures | `db/seeds/demo.ts` (+ `second-project.ts`, `reference-extras.ts`) | NXP/PAY projects, work items, capacity plan, frozen report history | LOCAL and CI only |

`db/migrate.ts` gates the fixtures on `SEED_ON_DEPLOY` **and** refuses them outright under
`NODE_ENV=production`, which is what deployed migrator tasks run with and nothing else does. Develop
used to set `seed_on_deploy = true`, so a database people read as real carried a fixture project and a
capacity plan; a shared environment whose contents nobody can vouch for is worse than an empty one,
because every bug report starts by asking which rows were fixtures. Both environments are now `false`
and the `NODE_ENV` floor means flipping one back would not be enough to reach a deployed database.

`resetFixtureTables` (`db/seeds/reset.ts`) TRUNCATEs and is wired only into `pnpm db:seed:test` and the
Playwright global setup — never into `seed()` or a migration. Its `FIXTURE_TABLES` list covers delivery
data and touches nothing in `access.*`, `workspace.*` or `identity.*`, so roles, the workspace, SSO and
users survive a reset. It does not name `iteration_team_baselines` or `release_team_targets`; those are
removed by `CASCADE` through their `ON DELETE CASCADE` parents (migrations 0098/0099).

## New business data: migration, seed, or neither

Three categories, three different answers. Get the category right before writing either.

**Reference data** — see "Permissions reach a workspace ONCE" above. Catalogue entry PLUS a backfill
migration; the seed alone will not carry it to an existing workspace.

**A schema or grain change over existing rows** — backfill inside the same migration, always.
`0101_capacity_allocation_fixed_value.sql` is the model: it freezes TODAY's resolved value so no plan
total moves on deploy, and it re-implements the service's own fallbacks in SQL (a per-size `COALESCE`
over the default preliminary-estimate map, `LEFT JOIN` for a missing settings row) so a
partially-customised workspace cannot fall back wholesale. Never leave a column NULL or `''` and expect
a later read path to cope.

**Time-series history** — `iteration_daily_snapshots`, `iteration_team_baselines`,
`release_daily_snapshots`, `release_team_targets`. **Cannot be backfilled, ever.** They are measurements
of a past day, and that data never existed. `SnapshotCronService` writes them hourly at :05, only for
dates inside an iteration's or release's own window, and baseline capture is `onConflictDoNothing` so it
cannot be re-taken. A fresh environment's Burndown and Burnup therefore start empty and fill forward,
and Velocity needs a FINISHED iteration before it says anything. The reports state that explicitly
(`noBaseline`, `historyState`) rather than drawing a flat zero line — do not "fix" that by synthesising
history.

## Test Cases (Phase 7): the trigger, the nullable Work Product, and two exceptions to shared rules

`libs/modules/test-cases` — a Test Case is a project artifact, OPTIONALLY attached to a Work Item.

- **`test_cases.work_item_id` is NULLABLE, but only work-item-scoped routes are exposed.** Rally's
  Test Case has an optional Work Product; ours schema-supports that today (D2) but ships no
  standalone `Quality > Test Cases` surface yet — every route in Phase 7 requires the parent Work
  Item. `TestCasesService.requireReadableWorkItem` is the ONE authorization check the whole module
  has: a Test Case is readable exactly when its parent is (`getWorkItemForView`, which already
  asserts `work_item:view` + team scope), so this module adds no second team predicate of its own.
- **`last_verdict` / `last_run` / `last_result_id` are maintained EXCLUSIVELY by a DB trigger**
  (`trg_test_case_last_result`, migration 0129), never by the service — the same reasoning
  `trg_sync_accepted_date` and `trg_task_iteration_from_parent` already established. It recomputes
  from the latest LIVE Result (`order by run_date desc, created_at desc`) on every INSERT, UPDATE
  (of `run_date`/`verdict`/`deleted_at`/`test_case_id`) and DELETE, and sets all three back to NULL
  when no live Result remains. `UpdateTestCaseSchema` and `UpdateTestResultSchema` both omit these
  columns so the contract does not advertise what the trigger owns.
- **`entity_ref_type` widened to admit `test_case` and `test_result`** for attachments — a shared
  enum across `comments`, `attachments` and `milestone_artifacts` (§2.6), so widening it for one
  consumer technically opens the other two. Attachments got a deliberate `UploadPolicy` per new
  owner; `CollaborationService.assertCommentableEntity` REFUSES both new kinds explicitly (the SRS
  names no comment thread on either) — asserted in `collaboration.service.spec.ts`, or the widened
  enum would have silently become a feature nobody designed.
- **`Not Run` / `Not run yet` is a SECOND declared exception to `EMPTY_VALUE`** (BR10), alongside
  Capacity's `Dependencies` `0`. A Test Case with no Result renders these words, never `--` and
  never `0` — `lastVerdict`/`lastRun` being `null` is a fact (no Result exists yet), not an absent
  read.
- **The Type catalog (`work.test_case_types`) is per-PROJECT and modelled on `work.labels`**, but
  soft-hidden (`archived_at`) rather than hard-deleted, because `test_cases.type` stores the Type
  NAME as a text SNAPSHOT (D8) — a removed Type must keep rendering on every historical Test Case
  that used it (BR17, AC17). `POST`/`DELETE /projects/:id/test-case-types` are gated
  `workspace:edit` (Workspace-Admin-only, matching the structural project routes — see "A
  per-Project Admin has NO structural authority" above), **not** `project:edit`. The FIVE default
  Types are seeded twice, deliberately: migration 0129's one-time backfill for every project that
  existed before Phase G shipped, and `ProjectsService.createProject`'s own create-time loop (the
  same shape as `DEFAULT_WORKFLOW_STATUSES`) for every project created afterward — one seeds the
  past, the other seeds the future, and neither re-runs the other's job.
  BR17's union (the Detail page's Type select showing a historical value that is no longer live) is
  resolved entirely CLIENT-side, from the row's own snapshot string — no server `includeArchived`
  read exists, because there is no FK to look an archived row up by.

**Declared divergences from Rally, in Test Cases** (the reasons behind D2–D8 above, and the design
choices they replace):

1. **No standalone Test Case surface.** Rally has `Quality > Test Cases`, Test Folders and Test
   Sets; Phase 7 exposes Test Cases only through a Work Item. The schema is ready (`work_item_id`
   nullable); the UI is not built.
2. **No Test Folder, Test Set, Last Build, Tags, Color, or Expedite fields.** Rally's Test Case
   carries all of them; the SRS field list is exhaustive and names none.
3. **`Validation Input` is not required**, though Rally marks it required — the SRS makes `Name`
   the only required create field, and every content field starts blank.
4. **Rally's Test Case Result has a `Test Set` field; ours has none**, because there are no Test
   Sets.
5. **Test Case Type is per-PROJECT and admin-editable.** Rally's is a workspace-level customisable
   dropdown; per-project is the BA's model.

## Observability

The implementation lives in `@quynhonsemiconductor/observability` — shared with opshub, so fix it
there, not here. `libs/platform` keeps only re-export façades (`observability/index.ts`,
`context/request-context.ts`) so existing `@platform` import sites stay valid.

- **One AsyncLocalStorage.** `request-context.ts` re-exports the package's store. A
  second local instance would mean HTTP requests seed one store while the pino mixin
  reads another, and every request log line would silently lose `workspaceId`,
  `userId` and `correlationId`. `request-context.spec.ts` pins it.
- **Don't log `correlationId`/`workspaceId`/`userId` by hand.** The pino mixin adds
  them to every line from ALS, plus `trace.id`/`span.id`. Background work must call
  `withJobContext(name, fn)` or it has no context at all.
- **`@Span` is deliberate, not universal.** Auto-instrumentation already spans every
  HTTP request, DB query, cache call and AWS SDK call. Add `@Span` for internal
  fan-out, hot paths, or long-running domain operations — not for CRUD passthroughs,
  where it just duplicates the pg span underneath. 5 of 23 services have spans and
  that is fine.
- **Never put an id in a metric label.** The recorder signatures make it a type
  error; `normalizeRoute()` is the safety net when a route template isn't available.
  IDs go on spans and logs.
- **Metrics are emitted, not declared.** If you add a name to `METRIC_NAMES` in the
  package, something must record it — a spec asserts instruments == names. This repo
  previously declared 23 names and implemented none.
- **`OTEL_ENABLED` is live in both environments now** (`module.otel_agent_{api,worker}.enabled`,
  true once `otlp_endpoint` is set — it is, in both `infra/live/develop` and `infra/live/prod`).
  Spans, metrics, logs and traces all flow to Grafana Cloud (Mimir/Loki/Tempo) via the OTLP
  gateway, with dashboards, per-env alert thresholds, log-to-trace derived-field correlation
  and CloudWatch alarms for RDS/ECS/ALB/cache/SQS alongside it. This reverses the note that
  used to be here ("`OTEL_ENABLED` is `false` everywhere, no collector exists") — that was true
  before the stack was built out; do not trust it. See
  `docs/superpowers/specs/2026-07-26-observability-architecture-design.md` for the original
  design (now largely implemented, not aspirational) and `docs/runbooks/alerts/` for what to
  do when one of the four Grafana alert rules fires.

## Infrastructure invariants

- **`infra/live/{develop,prod}/main.tf` hold values, never resources.** The whole
  stack is `infra/modules/stack`, so the two environments cannot drift
  structurally — only in what they feed in. Adding a resource means editing the
  module once. Relocating an existing address needs a `moved{}` block in
  `infra/live/*/moved.tf`, or Terraform destroys and recreates it.
- **Security posture is not a per-environment knob.** The cache module always
  enables KMS at rest and TLS in transit, which is why `REDIS_URL` is always
  `rediss://`. ioredis turns TLS on from that scheme alone — no client option is
  needed, and `redis://` against these nodes simply fails to connect. Develop
  cannot be configured weaker than production here; sizing is the only difference.
- **Sessions live only in the cache.** That is why it sits outside the ECS tasks:
  it survives task replacement, so a deploy does not log everyone out. Replacing
  the cache node _does_ log everyone out — treat that as a user-visible change.
- **A secret REF is not always an ARN.** With `secrets_use_bundle`, the secrets module's
  `secret_arns` output returns `"<bundle arn>:<key>::"` — the ECS `valueFrom` form. ECS
  understands it; the Secrets Manager API does not, and rejects the whole string with
  `ValidationException: Invalid name`. So a value passed as a `secrets` entry is fine
  either way, but one passed as a plain **env var for the app to dereference at runtime**
  (`IDENTITY_HOME_SECRET_REF`, `GITHUB_APP_PRIVATE_KEY_SECRET_REF`) must be parsed.
  `SecretsManagerSecretResolver` is the one place that happens — it splits the key off the
  7-field ARN and reads it out of the bundle's JSON, which is what lets `use_bundle` flip
  in either direction with no app change. **Never call `GetSecretValue` with a raw ref.**
  This broke SSO login on develop for a day: every `POST /v1/bff/login/sso` was a 500 while
  the deploy, the migrator and the seed all reported success, because the seed stores the
  ref in `sso_connections.client_secret_ref` and only the *login* path dereferences it.
  IAM lists have the same trap from the other side and need `secret_iam_arns` instead.
- **An infra change alone does not take effect — it needs a deploy.** Terraform
  owns the task definition's environment and the Pages project's `API_ORIGIN`, but
  `ecs-service` sets `ignore_changes = [task_definition]` and Pages env changes
  only apply to the next deployment. Terraform registers the new revision; the
  deploy pipeline is what moves the service onto it. So `infra/**` is deliberately
  **not** in either deploy workflow's `paths-ignore`, and both have a
  `wait-for-infra` gate to sequence deploy-after-apply on the same sha. Re-adding
  `infra/**` there recreates a silent failure: the apply succeeds, the new
  definition is correct, nothing rolls, and the old value stays live. That is
  exactly how develop ran against a deleted cache endpoint (`valkey: down` on
  `/v1/readyz`) after the cache migration.
- **Don't roll the service from `infra-apply` instead.** Terraform's newest task
  definition carries a new _image_, so rolling onto it there would ship app code
  ahead of `Run database migrations`.
- **REMOVING infra the running code still uses needs the deploy FIRST.** The normal
  order is apply-then-deploy (`wait-for-infra` gates it), and for an addition that is
  right — the code arrives after the resource exists. For a REMOVAL it is backwards,
  and the window is not theoretical: deleting the SNS topic in #394 left the old
  worker publishing to an ARN that no longer existed, the resilience breaker for
  `sns.publishOutboxEvent` opened, and six `outbox_events` rows burned all five
  attempts to `status = 'failed'` in the seconds before the new worker rolled. `failed`
  is excluded from every relay's fetch, so those rows were stranded SILENTLY — the
  projection looked healthy precisely because nothing was left pending. Migration 0103
  is the cleanup; the rule is the fix. Expand/contract: ship the code that no longer
  needs the resource, let it roll, then remove the resource in a second change.
- **ElastiCache cluster ids and replication-group ids share one namespace.**
  `CreateReplicationGroup` fails with `InvalidParameterValue: Cannot have a
cluster and replication group with same identifier` while a same-named cluster
  is still deleting. Terraform runs an unrelated destroy and create in parallel,
  so a same-name migration between the two resource types needs two applies — the
  plan cannot show you this.

## Environment flags that look wrong and are not

Two settings in `infra/live/*` read like mistakes. Both are deliberate; changing
either opens a hole or leaks API surface.

- **`NODE_ENV=production` in DEVELOP.** Not a copy-paste error. `devLoginAllowed`
  in `@quynhonsemiconductor/identity` is `nodeEnv !== 'production'`, so flipping develop to
  `development` would expose the **passwordless** `/v1/bff/dev-login` on a public
  host — anyone knowing a seeded address (`dev@qnsc.dev` is in this repo) could sign
  in as that user with no password. Develop deliberately requires real Entra SSO.
  If a local passwordless login is wanted, run the app locally where `.env` sets
  `NODE_ENV=test`; do not change the deployed value.
  (`LOG_PRETTY` is pinned `"false"` in infra, so JSON logs do not depend on this.)

- **`SWAGGER_ENABLED` unset (= off) in BOTH environments.** `/api/docs` publishes the
  full endpoint inventory and every schema, unauthenticated, and both API hosts are
  public. Explore the API locally instead — `.env` sets `SWAGGER_ENABLED=true`, so
  `localhost:3000/api/docs` works while developing. It used to be derived from
  `NODE_ENV !== 'production'`, which meant any non-prod-labelled environment
  published it without anyone choosing to; that is why it is now explicit opt-in.

## Auth model (read before touching a guard)

- **Browser sessions are BFF, not bearer.** The SPA holds no tokens. It talks to a
  same-origin Cloudflare Pages Function (`apps/web/functions/v1/[[path]].ts`) that
  proxies to the API, and authentication rides an opaque `__Host-rova_session`
  cookie backed by a server-side Valkey session. Bearer still works for machine
  clients — `JwtAuthGuard` handles both paths.
- **One guard, one decorator.** `PolicyGuard`
  (`libs/modules/access/src/interface/http/policy.guard.ts`) is the single
  authorization decision point. Controllers carry `@AuthPolicy()`; routes carry
  `@RequirePermission(...)` from `@modules/access`. The signature is tier-safe by
  overload: a workspace-tier code takes NO scope, a project-tier code REQUIRES one
  (`{ from: 'param'|'query'|'body', field }`, or `{ resource, from, field }` to
  resolve the project by loading the row). Passing the wrong shape is a compile
  error, deliberately. `@Auth()` is authentication ONLY — it grants every
  authenticated caller, so use it only where the surface is self-scoped
  (`me/*`, `notifications/*`) or runs around a session existing (`auth/*`).
  The old `@platform` `RequirePermission` + the `PermissionGuard` from
  `@quynhonsemiconductor/identity` are gone; so is `@RequireProjectPermission`.
- **A route with no `@RequirePermission` is OPEN, not denied.** `PolicyGuard`
  returns `true` when it finds no metadata, and `@AuthPolicy()` sets none. That is
  why `test/route-policy.ratchet.spec.ts` counts undecorated handlers and only
  ever lets the number fall.
- **Permissions are NEVER in the token.** The access token carries identity only.
  `PolicyGuard` resolves them from the database on every check, through one cached
  read per (workspace, user) (`authz:assign:<ws>:<user>`, 5-min TTL) that serves
  both tiers. Write paths call `AccessService.invalidateUser(s)` after commit, so a
  grant or revocation lands on the user's NEXT request — on every replica. Do not
  reintroduce `claims.permissions`: that snapshot is what forced the old
  authorization-epoch counter, and the epoch is gone with it.
- **A principal's `permissions` array is inert.** Nothing reads it. An e2e fixture
  cannot grant itself anything by declaring a list — it needs a real assignment
  (see `ensureViewerGrant` in `test/e2e/support/flow-harness.ts`).
- **Project scope is additive.** A project-scoped role can only add permissions; it
  cannot subtract a workspace-wide grant. Known limitation, tracked in
- **CSRF is enforced by a hook, not per route.** `requiresCsrfProtection`
  (`libs/platform/src/http/csrf.ts`) is the one place the policy lives. A raw
  `fetch` write in the SPA must send `X-CSRF-Token` via `withCsrfHeader`.
- **Two paths fail open** when Valkey is down: the token denylist and the rate
  limiter. Each emits BOTH a `securityFailOpen` log field (matched by a CloudWatch
  metric filter + alarm) and a `security.fail_open` counter. The `FailOpenControl`
  union in the package is the one source for both, and `fail-open.spec.ts` greps
  `infra/live/*` to prove the field the package emits is the field the Terraform
  filters on. (The union still declares `authz_epoch` / `authz_epoch_bump` from the
  deleted epoch service — nothing emits them now; drop them on the package's next
  major.)
- **The permission cache degrades, it does not fail open.** A read or write error
  falls back to the database, so authorization stays correct and only latency
  suffers. It logs a warning and is deliberately NOT tagged `securityFailOpen` —
  that field means "a security control was skipped", which is not what happens here.

## API tokens: four things that are correct in isolation and wrong in the graph

Full account — every invariant with the incident that produced it: [`docs/lessons/api-tokens.md`](docs/lessons/api-tokens.md)

## Sibling repo

`opshub` (`../opshub`) is a second product on the same architecture, and the
boilerplate is meant to stay identical: workflows, `infra/`, `libs/platform`,
`libs/shared-kernel`, `apps/*/bootstrap`, `apps/web/src/{shared,app}`. A fix to any
of those here should be ported there in the same week, and vice versa.

**A difference between the two repos is either declared in `docs/DIVERGENCE.md` or it
is drift.** Read that before "aligning" anything — several differences are deliberate
(opshub is single-tenant with `self|team|dept|region` scopes and dotted permission
codes; rova is workspace-scoped with `ns:*` wildcards).

rova is ahead on infra, CI gates, BFF auth and test depth; opshub is ahead on
authorization scope dimensions, delegation and IdP role mapping. Both now resolve
permissions from the database — see
`docs/superpowers/specs/2026-07-28-auth-convergence.md` for the shared model and the
ordered list of what opshub still has to do. 
What may live in a _shared package_ is a separate rule, recorded in
`app-platform/docs/ADMISSION-TEST.md`: divergence that would be a security
defect or a cross-repo contract break belongs there; divergence that would merely be
inconsistent stays in the product.

## Conventions

- Conventional commits, scope required for `feat` and `security` (`feat(auth): …`).
  release-please owns versions and the changelog — never bump by hand.
- Errors: throw the domain exceptions from `@platform` (`NotFoundException`,
  `ConflictException`, `PermissionDeniedException`, …) with a stable code the
  frontend can branch on; the global filter maps them to HTTP.
- New env vars go in `libs/platform/src/config/env.schema.ts` (validated at boot,
  fail fast) **and** `.env.example` **and** CI **and** `infra/live/*`. Booleans use
  the `booleanish` helper — `z.coerce.boolean()` turns `"false"` into `true`.

# Access model: declared divergences from the BA

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

Three rulings made on 2026-08-14, after an eight-slice audit cross-checked the code against BA main
(`product-docs` `55e7dbb`) and against real Broadcom Rally. None is drift; none should be "fixed" on
sight. The audit and its sourced Rally research are in
`product-docs/projects/mini-rally/09_Gap_Audit/`.

- **There is NO `Viewer` level, and Rally disagrees.** The BA removed it (`product-docs` `55e7dbb`,
  2026-08-14). It was restored by architect ruling the same day and **removed again on the BA's
  instruction** — migrations 0113 then 0115. The model is Workspace Admin plus per-Project `admin` or
  `editor`, with **No Access implicit** when no active `project_members` row exists; `No Access` is
  never a stored value or a dropdown choice, only the absence of a row reached through `Remove`.

  Recorded because it will come up again, and because the next person to read Broadcom's docs will
  reach for it. Real Rally's `ProjectPermission.Role` is No Access / Viewer / Editor / Project Admin,
  and its Viewer is load-bearing five ways: the documented answer to "make this user read-only", the
  **provisioning default** for a new user, one of four Quick Filter Toggles on the admin permission
  grid, the demotion target in the team-membership state machine, and a full-licence consumer whose
  only purpose is access control. So with `admin`/`editor`/absent alone, a read-only stakeholder or
  auditor is either invisible or a full Editor — the two configurations Rally customers most often
  need to avoid. If that becomes a real problem it needs a **new ruling**, not a quiet re-add: the
  CHECK constraint, `ACCESS_LEVEL_PERMISSIONS`, the DTO enums, the SPA's `access-levels.ts` mirror and
  the generated client all have to move together, and the last attempt showed what happens when one of
  them lags — `AccessService` filtered its synthesized assignments on a hand-written
  `'admin' | 'editor'` pair in two places, so a granted row read as No Access. Use
  `isProjectAccessLevel`, never an inline comparison.

  Sourced evidence: `product-docs/projects/mini-rally/09_Gap_Audit/research/RALLY_PERMISSIONS_MODEL.md`.
- **Team-scoped Editor is DROPPED as an authorization scope** (ruling 2026-08-14, reversing the
  earlier "KEPT" ruling of the same day — recorded rather than deleted, because the next person to read
  the BA's §2.2 will reach for it again). The BA scopes an Editor's writes to their assigned Teams
  (§2.2, §3.2 "in assigned Teams"), and Rally has **no `Team` object and no team authorization scope**
  at all — `POST /user/<OID>/teammemberships/add` takes **project** refs, and "Team Member" is a
  presentational checkbox with auto-promotion to Editor. Our own research file said "do not build a
  team scope"; it was kept anyway because the BA models Teams as first-class.

  **What reversed it was our own schema, not Rally's docs.** A team scope can only restrict rows that
  CARRY a team, and `portfolio_items.team_id` and `work_items.team_id` are both nullable and mostly
  unset (195 of 206 local iterations name no team). `assertTeamScoped` therefore admitted every
  `teamId === null` row *by design* — so the boundary admitted the ordinary case, which makes it a
  filter with a security-sounding name rather than a control. It covered 3 of ~14 Editor-reachable
  writes and **no reads**: the worst available state, because it reads as a boundary in review and is
  not one. Finishing it honestly would have required making `team_id` MANDATORY on every
  Editor-writable row — a data-model change across portfolio, work items and iterations, plus
  team-scoped read models on every list, report and picker.

  **THE FRESH RULING ARRIVED: reinstated 2026-08-17.** `GAP-P4-RBAC-003` is a BA-confirmed P0 Fail —
  an Editor with no assigned Team read another team's Story in full and was offered `All Teams`,
  Pegasus and RTCAP in the selector — citing §2.2, §3.1–3.2, §7 and AC #3–#5. The paragraph above is
  kept because its objection was right, and because the BA's follow-up answer is what finally settles
  it. Asked directly whether `team_id` had to become mandatory, they ruled:

  > "Keep `team_id` nullable. Null means **Project Backlog**, accessible only to Workspace Admin and
  > Project Admin. Editor must select one of their assigned Teams when creating a Work Item and cannot
  > access team-less items. Enforce this consistently in API queries, lists, reports, search, pickers
  > and direct URLs. No DB migration or backfill is required."

  So the nullable column is not a gap to be closed — it is a **THIRD population with its own
  audience**, which is why no migration was needed. `AccessService` holds both halves and nothing else
  may re-implement either:

  - **`assertTeamInScope`** — the per-record decision. For an `editor`: no active roster row on any
    team actively linked to the project → `EDITOR_NO_TEAM_SCOPE` (AC1); another team's record →
    `TEAM_NOT_IN_SCOPE` (AC3); a record with NO team → `PROJECT_BACKLOG_ADMIN_ONLY`. That third code
    exists rather than reusing the second because "this is the Project Backlog" and "this is someone
    else's Team" are different facts and only one is something the reader can act on.
  - **`resolveTeamScope`** — the SAME decision in the shape a query needs, and every list, report,
    search and picker narrows through it. `{ unrestricted: true }` for a Workspace Admin, a
    per-project `admin`, or a principal with no level at all (whose refusal is
    `assertProjectPermission`'s — narrowing them to zero teams would turn a 403 into an empty grid,
    which reads as "this project has no work"). Otherwise their own team ids.
  - **`team_id IN (…)`, NEVER `IN (…) OR IS NULL`.** That OR-NULL form is right for ITERATIONS
    (`teamOrSharedTimebox` — a timebox with no team is a shared sprint) and wrong for WORK ROWS. The
    two rules sit in adjacent queries; say which one a predicate is when you write it.
  - **An empty array is an answer, not a missing filter.** `{ teamIds: [] }` must return nothing;
    flattening it to "unrestricted" hands that Editor the whole project, the same `null`-versus-`[]`
    trap `listReadableProjectIds` documents. Short-circuit rather than emitting `inArray(col, [])`.
  - **Create is a REQUIRED CHOICE, not a refusal to read.** An Editor omitting the Team gets
    `WORK_ITEM_TEAM_REQUIRED` (412), because `PROJECT_BACKLOG_ADMIN_ONLY` reads as "you may not open
    that" — true of a read and useless on a form.
  - **A per-project `admin` keeps All Teams AND the Project Backlog** (§3.1), so
    `GET /projects/:id/teams` narrows for a reader through `listProjectTeamsForReader` while the
    unscoped `listProjectTeams` stays internal — it is also the home of the "team must be linked to
    this project" rule, and a rule that cannot see every link would make an Editor unassignable
    inside their own team.
  - Reached from `WorkItemsService` on read-by-id, read-by-key, create, update (BOTH the current team
    and a moving destination) and delete. Pinned over real HTTP in
    `test/e2e/editor-team-scope.e2e.spec.ts`; the zero-team half is in `access.service.spec.ts`,
    because the e2e cannot express it without emptying a seeded principal's rosters, which other files
    measure.

  **A boundary the READS do not share is a filter with a security-sounding name** — that is the whole
  lesson of the removal note above, and it is why the ruling's own sentence lists lists, reports,
  search, pickers and direct URLs. A new read over work rows inherits nothing automatically: it must
  take the scope. What that cost, in one pass, and what each half is worth knowing for:

  - **`TeamReadScope` is exported from `@modules/access` and nowhere else.** Four modules had derived or
    re-declared it within a day of the rule landing; four copies of one decision table is the drift the
    rule exists to prevent. `libs/modules/{work-items,iterations,quality}/src/domain/team-read-scope.ts`
    re-export it and keep only their own SQL helpers.
  - **`scope` is a REQUIRED repository parameter**, not an optional one, in every port it reaches. A new
    call site that forgets the boundary is then a compile error rather than a silent widening.
  - **Every sub-resource of a work item is a disclosure of that work item.** `:id/activity`,
    `:id/labels`, `:id/relations`, `:id/milestones`, `:id/time-logs`, `:id/watchers`, `:id/attachments`
    and both attachment-download routes all loaded the row through the unscoped `getWorkItem`, so the
    record was refused while its Revision History, links, logged hours, watchers and attachment BYTES
    were not. `requireReadable` is the one scoped read path; a signed URL outliving the request is why
    the download pair was the worst of them. Comment threads had the same hole through
    `CollaborationService`, which is a different module and needed its own fix.
  - **Writes leak just as well as reads.** `bulk-release`, `bulk-iteration` and both reorder routes
    authorised the PROJECT in the body and never the rows, so a bulk call was the cheapest way to move
    another Team's work — or the Project Backlog's — with no UI involved. `loadBulkItems` now checks
    every row, all-or-nothing.
  - **A grid must not offer a row its own record endpoint refuses.** The Tasks tab narrows by
    `coalesce(task, parent, iteration)` while `GET /work-items/:taskId` read the row's own column, so a
    task under a teamed Story was listed and then refused. `resolveRowTeam` is the shared resolution,
    and it asks for the third tier only when the first two are null.
  - **Frozen Burndown history cannot be re-sliced, so a multi-team Editor gets NO series.** The
    `team_id IS NULL` snapshot row is a MEASURED All Teams row that spans teams they may not see, and
    summing the team rows is forbidden (this file, above). So `frozenSeriesScope` serves one team's own
    rows for a one-team reader and reports the series UNAVAILABLE for two or more, with
    `hasScheduledWork` still live — "work exists, this scope's history is unavailable" rather than
    "nothing scheduled". Arithmetically a sum would be exact for `iteration_daily_snapshots` alone; the
    release burnup cannot follow (a team-agnostic child counts inside every team row), and one report
    aggregating while its neighbour refuses is worse than both refusing.
  - **`All Teams` is not a lie for an Editor: it is `My Teams`.** Their default report scope returns
    that label, because `All Teams` would be false twice over — other teams, and the Project Backlog.
  - **Two REFUSALS on create, and they are not interchangeable.** Another team is `TEAM_NOT_IN_SCOPE`;
    no team at all is `WORK_ITEM_TEAM_REQUIRED`. On a form the reader needs to know which field to
    fill, which is also why `CreateIterationItemDto` gained an optional `teamId`: a SHARED iteration
    (195 of 206 local ones) has no team to inherit, so without it Add Item was closed to exactly the
    role §3.2 grants it to. A chosen team wins over the inherited one; the refusals still decide.
  - **What is still NOT narrowed, deliberately.** `activeProjects` / `activeSprints` on the Home strip
    count CONTAINERS, and `iterations.team_id` is unset on ~195 of 206 rows, so a strict predicate
    would drop exactly the shared sprints an Editor works in. And a Release Tracking Direct row's
    `childCount` / `progress` / `mismatches` stay scope-blind per RT-BR-05, so an Editor can infer
    aggregate counts for children of a Feature their team owns. Both are recorded here rather than
    quietly narrowed, because narrowing either would give one number two definitions.

  Everything else about Teams is unchanged: **delivery-model data, and a display filter.** Team
  membership, `team_members`, Team Status, Team Capacity and every report's team scoping are untouched
  — and note `RBE-06` grants `editor` from a team roster row, which IS Rally's model arrived at from
  the other direction.
- **A per-Project `Admin` has NO structural authority**, following the BA over Rally. §3.1 marks
  every structural row Hidden for Admin — create/edit/archive/restore/delete Project, create/edit/
  deactivate/restore Team, assign Project access and Team membership — and gives it Read-only on
  "View Project Details and Teams". Rally's Project Admin *does* configure its project and edit
  viewer/editor/team-member permissions, so this is deliberate. In code: `PATCH /projects/:id` and
  the two `:id/teams` link/unlink routes carry **`workspace:edit`** (workspace-tier, WA-only), not
  `project:edit`.

  **`project:edit` deliberately STAYS in the Admin set**, because it also gates label and
  workflow-status configuration — delivery configuration, which §3.1's own summary gives Admin
  ("`Admin` is powerful for delivery management") — and because `View Permission Model` is a §3.1
  Admin row gated on that code. So do not read "Admin must not hold `project:edit`" from the rule
  above; read "the structural routes must not be gated on it".

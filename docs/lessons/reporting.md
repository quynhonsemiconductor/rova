# Reporting: frozen history vs live queries

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

Four surfaces share one module (`libs/modules/reporting`) but not one data strategy, and the
difference is the whole design. Read this before changing a report or the snapshot job.

- **Burndown is FROZEN history; Velocity and Team Capacity are LIVE queries.** Task To Do is
  overwritten in place, so yesterday's remaining hours only exist if something wrote them
  down — hence `iteration_daily_snapshots`. Velocity deliberately has no snapshot: moving an
  item out of a closed iteration must change that bar. Never "unify" the two paths.
- **The snapshot cron runs HOURLY and writes only TODAY's workspace-local date.** Date cutoffs
  are per workspace (`workspace_settings.timezone`), so one UTC-midnight tick is wrong for
  every workspace that is not on UTC — which is what it used to do. The value that survives a
  day is the last tick before that workspace's midnight; when the local date rolls over the
  day stops being addressed and is marked `finalized`. A missed day stays a GAP: the report
  renders it unavailable, and `buildFallbackSnapshots`-style interpolation is prohibited.
- **`work_items.accepted_date` is maintained by a TRIGGER** (`trg_sync_accepted_date`,
  migration 0087), not by the service: `db/seeds/**` and raw SQL write this table directly,
  and an Accepted row with no acceptance timestamp is a data-quality error the reports refuse
  to guess about. The trigger never invents a date for a row that was already accepted before
  0087 — those stay NULL and Velocity reports them as `unclassified`. Verified by experiment:
  `accepted` sets it, `release` RETAINS it (accepted-equivalent), reopening clears it, and a
  later re-acceptance writes a fresh, later timestamp. Velocity SRS §3 gives DEV a backfill for the
  pre-0087 rows and `pnpm db:backfill:accepted-date` (`--dry-run` to report only) is it: the date comes
  from the LATEST `work_item.schedule_state_changed` activity row into an accepted state — latest, not
  earliest, because an item can be accepted, reopened and accepted again. It refuses to touch a row that
  already has a timestamp, and a row with no such history is REPORTED and left NULL rather than dated on
  no evidence.
- **The timebox says WHICH window; the WORK says whose it is.** `iterations.team_id` is optional
  here (real Rally collapses project and team, we do not), so a project may run one shared sprint
  every team works inside — 195 of 206 local iterations name no team. Filtering reports on
  `iterations.team_id` therefore returned NOTHING for a selected Team while Team Status showed the
  hours, and Velocity, which had no team predicate on the work at all, credited every point in a
  timebox to whatever team the timebox named. A team-scoped report now takes the team's own
  iterations **plus the shared ones** (`teamOrSharedTimebox`) and narrows the numbers per row by
  `coalesce(item.team_id, iteration.team_id)` — the same two-tier rule `getScopedTaskHours` and
  Team Status already used. An unknown `teamId` is a 404, never relabelled `All Teams`.
- **Nothing keeps `work_items.team_id` and its iteration's team in step by itself.**
  `assertIterationAssignable` refuses the pair with `ITERATION_TEAM_MISMATCH`, but the update path
  only checked it when the patch mentioned an iteration — so moving an item to another team left it
  parked in the old team's sprint, in two steps instead of one. A team change now revalidates the
  iteration the item already sits in. Seeds bypass the service entirely, which is how `US-D2` came
  to be Team Beta's story inside Team Alpha's Sprint 26.1.
- **`iterations.timebox_group_id` is how All Teams fuses per-Team iterations.** It is DERIVED
  from (project, start, end) — `timeboxGroupIdFor()`, migration 0088 and the trigger added in 0093
  share one expression, pinned by a spec — and computed ONCE, so a later date edit cannot split a
  historical bar. The approved mockup shows the failure this prevents: two adjacent velocity
  bars both labelled 25.1. It is maintained by a **trigger** because the service was demonstrably
  not the only writer: `create` set it, `update` omitted it, and `db/seeds/**` inserts dated
  iterations directly — 40 rows had dates and no group, three of them sharing a window with four
  that were grouped, so each became its own bar.
- **The Ideal BASELINE is per TEAM too, and All Teams is the SUM** (`iteration_team_baselines`,
  migration 0098). Two different rules for two different quantities, both stated by IB §4: the
  snapshot rows' `team_id IS NULL` is a MEASURED All Teams row that is never summed, while here
  `team_id IS NULL` means "work whose team cannot be resolved" and every row IS summed for All Teams.
  Migration 0093 gave the rows a team dimension and left the baseline as one column on `iterations`, so
  a team-scoped chart drew the WHOLE PROJECT's Ideal against one team's bars — and because §6 compares
  `remainingToDo(d)` with `ideal(d)`, the indicator read "On track" for a team that had burned nothing
  and could not read "Behind plan" until a team exceeded every other team's estimate as well. Capture
  groups by the same `coalesce(task, parent, iteration)` team the hours are measured with, so the
  baseline and its bars can never be scoped differently. The release Ideal target got the same
  treatment in migration 0099 (`release_team_targets`), which also DROPPED
  `releases.ideal_target_points` / `_count` — so a note here claiming that target "still has this
  defect" is stale, and it named two columns that no longer exist. Both quantities are now per-team.
- **The snapshot job only writes INSIDE the timebox window.** `findActiveIterations` selects on
  `state = 'committed'` and nothing else, and committing early is legal — so an iteration committed
  before it started had its *immutable* baseline captured at commit time, commonly zero because tasks
  are broken down after commitment. A captured `0` is the trap: it is not null, so it passes every "no
  baseline" check, `idealLine(0, N)` returns zeros, the `noBaseline` note stays hidden, and a flat zero
  line is drawn as a measured plan. The release loop always had this guard; the iteration loop now does
  too.
- **Eligibility must be counted in the SAME scope as the measurement.** Velocity's eligibility join
  carried no team predicate while `getVelocityItems` narrowed by `coalesce(item, iteration)`, so a
  shared timebox became an eligible bar for a team whose work was then filtered out of it — a
  zero-point bar for a sprint the team never worked in, dividing Trend, Last 3, Best 3 and Worst 3.
  `countScheduledWork` had the mirror image: counted project-wide, a team with nothing in a shared
  sprint was told its snapshot history was missing. Both now take the scope.
- **A LIVE fact must not outrank FROZEN history.** `hasScheduledWork` is a live count and the series is
  frozen, so a rolled-over iteration reported `historyState: 'complete'` with a full recorded series
  and the screen replaced it with "no scheduled work". §5 makes only MISSING SNAPSHOTS unavailable, so
  the live emptiness is consulted last. Same mistake as the missing-baseline one, in a different place.
- **Burndown history carries a TEAM** (`iteration_daily_snapshots.team_id`, migration 0093).
  `team_id IS NULL` is the All Teams row and every scope is MEASURED independently — the All Teams
  row is never the sum of the team rows, or a task two teams both touch counts twice. Frozen
  history cannot be re-sliced on read, so without the column a team-scoped Burndown simply could
  not be served; a read picks exactly one series (team rows, or the All Teams row), never both.
  Team rows begin at 0093, so a team-scoped chart of older history is an honest gap.
- **In Release Tracking, a team-agnostic row counts inside EVERY scope** — `inScope` admits
  `teamId === null` under a selected Team, not just under All Teams. This is NOT the
  `coalesce(item, iteration)` two-tier rule used elsewhere: a release owns no timebox, so there is no
  second tier to fall back to, and the strict `team_id = ?` it replaced dropped the ordinary case
  (`portfolio_items.team_id` and `work_items.team_id` are both nullable and mostly unset). The
  per-Team totals therefore do not sum to All Teams, which is already this report's contract.
  **The predicate is shared by the live report and by `ReportSnapshotService` on purpose** — one rule
  for a measurement and for its own eligibility, the property whose absence caused the zero-point
  Velocity bars. The cost of that sharing is that changing the rule changes what the FROZEN writer
  records, and two things follow, both of which a future rule change must handle again:
  `release_team_targets` is captured once per (release, team) with `onConflictDoNothing`, so already
  captured targets keep the OLD population and the Ideal line sits permanently below its own bars —
  migration 0116 deletes the team rows (never the All Teams row, whose population did not move) so the
  next tick re-takes them under the same rule that measures the bars. And `release_daily_snapshots`
  team rows written before 0116 measured the narrower population: an honest series break, recorded
  here exactly like "team rows begin at 0093" above, never interpolated away.
- **`GET /releases/:id/burndown` is gone** (with the Release detail progress panel and seven DTO
  fields). It answered "how far along is this release?" from the same `release_daily_snapshots` rows as
  Release Tracking but under a different definition — All Teams only, no scope control, no Ideal — so
  two surfaces gave one release two numbers. FR-037 puts release progress in
  `Portfolio > Release Tracking`; Phase 3 Release list/detail must not add a progress column or widget.
  Do not re-add a progress reader here.

  **The `Task Roll-up` + `Accepted` panel went with it, on the BA's 2026-08-17 retest.** It had been kept because
  FR-018 was once read as putting those numbers in the right panel. The
  BA re-confirmed `GAP-P3-REL-001` as a **Fail**: FR-018 and AC #10 now list the panel's fields
  exhaustively (Start Date, Release Date, Project, State, Planned Velocity, Plan Estimate, Version),
  FR-023 forbids "Task Roll-up, Burndown or another Release progress widget", FR-024 puts
  accepted/progress totals in `Portfolio > Release Tracking` alone, and `P3-REL-DC-009` is Decided.
  Real Rally shows a roll-up there; the BA report wins. **The API still SERVES `taskRollup`** — the
  BA's own §7.4 detail DTO carries it, and its `estimateHours` is the list's `taskEstimate` column
  (FR-004) — so this is a display rule, not a contract change: the SPA's `Release` mirror does not
  declare the field, which is what stops a Phase 3 screen rendering it again.
- **The Phase 6 snapshot tables now have foreign keys.** `iteration_daily_snapshots` and
  `member_capacity` had NONE (verified against `pg_constraint`). Orphan snapshots happened to be
  unreachable through the API — deleting an iteration is blocked unless it is still `planning`, and
  only `committed` iterations are snapshotted — but orphaned `member_capacity` rows were reachable,
  and Team Capacity inner-joins `teams`/`users`, so an orphan row DROPS out and the Capacity total
  quietly falls while Estimate/ToDo/Actual stay. "Unreachable today" is a coincidence of two
  unrelated rules, not an invariant.
- **`workspace_settings.working_days`** (ISO 1–7, default Mon–Fri) is the Burndown x-axis and
  the Ideal line's index. The Ideal line is indexed by WORKING day and reaches zero on the
  last one; the mockup interpolates over calendar days and never reaches zero — the SRS wins.
- **`release_daily_snapshots.team_id IS NULL` is the All Teams row, and it is MEASURED, not
  summed** from the Team rows: a work item two Teams both touch must be counted once. Points
  and count live on the same row because `Chart Unit` is a display switch over one population.
- **An absent number renders `EMPTY_VALUE` (`--`), never `0`.** `data` is `undefined` both while a
  request is in flight and after it fails, so `?? 0` turns a network fault into a measured claim:
  Release Tracking showed three large zeros ("this release has no Features") and Team Capacity four
  `0h` cards ("this team planned nothing") — the latter directly ABOVE its own error message, because
  the error branch sat on the table and the KPI strip is above it. `ReportSurface` now takes an `error`
  slot so the strip and the body go absent together; a report that passes it must also render its
  `strip` in the absent state, since the strip is the caller's node. Velocity never read `isError` at
  all and rendered §6's own sentence "no completed iteration with scheduled work exists" for a 500.
  The KPI row stays MOUNTED through all of this — the BA's structure-preserving rule — which is exactly
  why the values cannot be coerced.
- Report series colours are `--report-*` tokens (both themes) in `globals.css`, exposed via
  `BRAND.report*`. They are data colours fixed by the BA, deliberately not `primary`.
- **A chart must pass `dataTable` to `ChartFrame`, and the SVG is `aria-hidden`.** A recharts plot is
  paths plus loose `<text>` nodes, so assistive tech reads a pile of numbers in painting order with
  nothing to say which series or which day any belongs to — and these reports ARE their values. The
  frame renders the caller's own row array as a visually hidden `<table>` instead (`sr-only`, never
  `display:none`), which is why the two cannot disagree. `null` renders as the caller's `noDataLabel`;
  a gap stays a gap here too.
- **`ChartFrame.underAxis` is for a SECOND axis row, not a footer.** The burnup's iteration band is
  part of the x-axis (RT §7, RT-AC-09: "X-axis shows dates and a secondary iteration-name row"). From
  `footer` it rendered below the legend strip and up to two history notes — ~90px from the dates it
  labels — where it reads as a third summary block.
- **`teamName === null` is `All Teams`, and it is the DEFAULT scope.** All four surfaces printed
  `teamName ?? ''`, so the scope a reader sees FIRST rendered as "NextGen Platform - " and "Team: ".
  Use `teamScopeLabel` / `reportScopeLabel` (`features/reporting/scope.ts`); the term is `All Teams`
  per every Phase 6 §6/§7, even though `capacity.json` and `settings.json` spell it "All teams".
- **A team-scoped iteration PICKER must offer the team's own timeboxes plus the shared ones**
  (`iterationsInScope`) — the client half of `teamOrSharedTimebox`. Do not pass `teamId` to
  `useIterations` for this: that filter is a strict `team_id = ?` and drops exactly the shared
  iterations the report measures, because SQL equality never matches NULL. `listAssignmentOptions`
  already had the OR-NULL form; the list endpoint does not.
- **An iteration is assignable by SCOPE, never by LIFECYCLE.** `listAssignmentOptions` filtered on
  `state IN ('planning','committed')` while the write path — `assertIterationAssignable`, over a
  `findIterationScope` row that selects `project_id` and `team_id` and no state — accepted a closed
  timebox happily. So the eligibility feed withheld a target the API allows, and that made HALF of
  Velocity's own rule unreachable: points follow an item's CURRENT iteration (Velocity SRS §4, the
  contract's §5.2), so moving a Story out of a finished sprint correctly moved the bar and no
  selector could ever put it back (P6-VEL-004). The predicate is gone; the team/iteration mismatch
  rule and `TASK_ITERATION_DERIVED` are untouched. Two consequences worth knowing: the two compact
  feeds now differ only in PROJECTION (`/iterations/options` also returns `teamId`), kept as two
  routes because the questions are still two and the SPA client is generated-and-committed; and the
  Rollover modal's destination picker still hides accepted iterations client-side, which is a
  deliberate lifecycle choice on `Plan > Timeboxes` ("move unfinished work forward") and NOT the same
  rule — if the BA rules on it, that filter is the one line to change.
- **`historyState` describes SNAPSHOTS only.** Both burndown and burnup once folded "no Ideal
  baseline" into that enum, which made a missing baseline discard measured bars that had really
  been recorded — IB §3 scopes the baseline to the Ideal LINE, and §5 makes only missing
  snapshots unavailable. The baseline is now reported separately
  (`totalTaskEstimateAtStart` / `idealTarget`, null when absent) and a fourth state `no-window`
  covers an iteration or release with no dates. That state exists because the alternative was a
  500: the service had nothing but `''` to pass, `'' < ''` slipped past the inverted-range guard
  in `workingDaysBetween`, and `addDays('')` threw `RangeError`.
- **`releases.ideal_target_points` / `_count` are captured ONCE, by the snapshot job**, on a
  release's first snapshot day, from the then-current planned scope — the same `IS NULL`-guarded
  capture as the iteration baseline, and for the same reason (RT-BR-09): an Ideal derived from
  today's Planned value silently redraws every past day whenever scope changes. Before this
  nothing wrote those columns at all, so the Ideal line could never be drawn for any release.
- **A sparse series needs DOTS, not just lines.** `connectNulls={false}` is right — a bridged gap
  is a fabrication — but a line segment needs two adjacent points, so a measured day between two
  gaps drew zero pixels and a young release rendered an empty grid beside populated totals. Give
  a dot an explicit `fill`: recharts fills dots white by default and draws the series colour as
  the ring, so `{ r: 2, strokeWidth: 0 }` alone is twelve invisible dots on a white card.
- **The demo seed writes frozen report history** (`seedReportHistory` in `db/seeds/demo.ts`).
  Both seeded timeboxes are in the past and the cron only ever writes TODAY, so without it every
  Phase 6 chart shows its empty state on a fresh database. The rows deliberately include a GAP,
  weekend audit rows and a sparse burnup — production must never fabricate history, a dev seed
  must, and those shapes are the ones worth being able to see.

# Feeds: the five incidents behind the rule

The rule itself lives in `CLAUDE.md` ("Feeds: one rule, and the ways it has been
broken"). These are the accounts that produced it — read the one matching the surface
you are touching.

### Incident 1 — empty dropdowns on Iteration Status (Production, 2026-08-21)

Owner AND Dev Owner inline dropdowns showed only `No Entry`; an active Team member could not be
assigned. Same on `Add Item`.

- Iteration Status called `useProjectMemberOptions(projectId)` — **no team** — so every row got the
  no-Team list. On a project whose members are Editors that list is empty.
- **The row could not have passed a team, because the read model did not carry one.** The
  iteration-status projection selected no `team_id` (added with this fix, plus DTO and a codegen
  round). The grid is the only place that knows a row's team, so the field is what makes the correct
  question askable.
- `useTeamOwnerOptions` fetches NOTHING without a team — deliberate ("No Team offers only
  Unassigned"), which is why silently falling back to the project-wide feed was worse than an empty
  list: it looked populated for admins and empty for the role that needed it.
- **Per ROW** (`useTeamOwnerOptions(projectId, item.teamId ?? fallbackTeamId)`). Rows sharing a team
  share one query key, so it is one request per distinct team on screen — and under `All Teams` each
  row asks with its own team instead of the screen's.
- **`Portfolio > Feature > Children` had the same shape.** Its projection ALREADY selected `team_id`,
  so no server change was needed — only pointing offers at `useTeamOwnerOptions(child.projectId,
  child.teamId)` and leaving the project-wide feed as the NAME source. Check the projection before
  assuming a codegen round.
- Pinned in `owner-name-resolution.e2e.spec.ts` and `status-row.test.tsx`.

### Incident 2 — assigned items reading `No Entry` (2026-08-22)

An Editor saw `No Entry`/`Unassigned` for items that WERE assigned. The grids carried ids only and
resolved the name client-side from a PICKER feed:

- `GET /projects/:id/member-options` **excludes Workspace Admins** (AC-16: not assignable owners), so
  it can never name one — for ANY role.
- `GET /workspaces/:id/member-options` narrows a non-admin caller to the members and `lead_id`s of
  their own readable projects (`listMemberOptions`).

A Workspace Admin holds no `work.project_members` row at all (§2.1, migration 0118), so an item they
own had no name source in either feed. **A Workspace Admin reader never saw it** because
`listReadableProjectIds` returns `null` — unrestricted — and the seeded case hides it too, because
every seeded project's `lead_id` IS the admin. Reproduce with an Editor whose projects name no admin
as lead.

- **The read models join the name now** — `ownerNameJoins` in `WorkItemDrizzleRepository`
  (`listByProject`, `listBacklog`, `listTasksByParent`) and the iteration-status projection.
  Portfolio, Releases, Milestones and Quality already did this; work items were the last module
  resolving a name on the client, which is why they were the only ones with the bug.
- **NAMING moved; OFFERING did not.** `owner-name-resolution.e2e.spec.ts` asserts both halves, so a
  later "simplification" that names from the offer list fails.
- **`work.tasks` has no `dev_owner_id`**, so a task's `devOwnerName` is null by construction.
- **Blank-name reports are usually this, not persistence.** An absent name and an unset field render
  identically, which is what made `GAP-P2-IS-004` look like a save that did not stick. Check whether
  the owner is a Workspace Admin before hunting the write path.

### Incident 3 — a Story with a Team offering only `Unassigned` (`GAP-P1-WID-007`)

BA-confirmed P0-adjacent Fail on the 2026-08-17 retest. Three separate defects:

- **A Workspace Admin on the team roster IS an Owner option.** `listProjectMemberOptions` subtracted
  Workspace Admins from BOTH branches on the older AC-16 reading; the ruling came. The exclusion now
  applies only to the PROJECT-WIDE branch, where §2.1 and migration 0118 mean a WA holds no
  `project_members` row anyway. The retest ACs name exactly two exclusions — outside the selected
  Team, and inactive.
- **A Task's options follow its INHERITED parent Team.** `TASK-FR-017` scopes them to "the inherited
  parent Team", and `work.tasks.team_id` only DEFAULTS to the parent's (SRS P1-04) and is nullable —
  so reading the Task's own value alone offered `Unassigned` and nothing else. The Tasks tab passes
  `parentTeamId` and resolves `task.teamId ?? parentTeamId`. NOT the Iteration rule: the Iteration is
  contractually DERIVED, the Team is merely defaulted.
- **Dev Owner saved correctly all along** — proven in `test/e2e/dev-owner-persistence.e2e.spec.ts`,
  the first coverage `devOwnerId` ever had. Names come from the workspace directory
  (`GET /workspaces/:id/member-options`, which returns inactive members for exactly this reason).
- **A Team move resets an Owner the new Team does not contain**, in the SAME patch and on the SERVER
  (`resetOwnerOutsideTeam`). Conditional, not unconditional — the same person can be on both teams.
  Clearing the Team clears the Owner outright (AC6) without reading any roster. Server-side because
  every surface can move a Team, and membership is asked of the picker's own feed so the server cannot
  count a different population than the screen offers.

### Incident 4 — no Defect could name its Parent Story (Production, 2026-08-21)

A Defect's `Parent Story` field offered only `No parent story`, and searching a Story's key answered
`No matches`. All three surfaces — detail sidebar, Create Work Item, Log Defect — read
`GET /work-items/backlog?type=story`.

- **The Backlog is a SCREEN, and `iteration_id IS NULL` is its defining rule** (see `listBacklog`).
  `updateWorkItem` has no such rule: it accepts any non-deleted Story in the same project. So every
  Story already pulled into a sprint — the ones a Defect is most often raised against — was withheld
  from a picker whose own server would have taken it. The 50-row first page was a second, quieter cap.
- **`GET /work-items/story-options` is the fix** — the Story REFERENCE feed, mirroring
  `GET /portfolio-items/options`: unpaged (a paged picker omits options past its first page without
  saying so), no schedule-state filter (a Defect against shipped work needs an ACCEPTED parent),
  `work_item:view` gated on the required `projectId`, and team-scoped in the service because that is a
  row boundary the guard cannot express. Declared ABOVE `@Get(':id')`, or Nest routes it into
  `ParseUUIDPipe` as a 400.
- Pinned in `test/e2e/parent-story-feed.e2e.spec.ts`. A service spec cannot see it: the repository is
  mocked, so no predicate is exercised.

### Incident 5 — an iteration is assignable by SCOPE, never by LIFECYCLE (`P6-VEL-004`)

The same shape in a different field, recorded under Reporting: `listAssignmentOptions` filtered on
`state IN ('planning','committed')` while the write path accepted a closed timebox happily, making
half of Velocity's own rule unreachable. See the Reporting section for the full account — it is listed
here because it is the canonical instance of "the feed was narrower than the write".

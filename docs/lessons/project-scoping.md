# Cross-project scoping

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

`AccessService.listReadableProjectIds` is the authorization fact behind every cross-project list — its
own docblock says so, and Portfolio already used it. `GET /v1/projects` did not: no
`@RequirePermission`, and a query filtering on `workspace_id` + `deleted_at IS NULL` alone, so every
project's key, name, description, owner, dates and counts was readable by any authenticated principal
including one with zero role assignments. PRJ-FR-001 and §10 both say otherwise.

**`null` means UNRESTRICTED and an empty array means "nothing".** The sentinel exists precisely because
those two are different answers, so a caller that flattens `null` to `[]` fails closed and one that
flattens `[]` to "all" leaks the workspace. The repository short-circuits the empty case rather than
emitting `inArray(col, [])`, which is not portable as "match nothing".

`GET /projects/:id/members` was open for the same reason and is now `project:view` scoped to the path
id — **with no `resource` key**, because the param IS the project id and there is nothing to resolve
(`'project'` is deliberately not a `ScopedResource`).

**That note used to end "still open", and both halves are now CLOSED — recorded because the
resolution is the pattern, not the exception.** `GET :id/members-with-profile` was deferred behind
"gating it needs the feed split first", because it fed the Portfolio and Projects owner pickers as
well as User Management. The split shipped (`:id/member-options` for pickers, `:id/members-with-profile`
for the administrative roster) and the administrative half now carries `workspace:view`. And
`GET :id/members` — the third route, paged, with `roleId` and account `status` behind an in-service
claim that amounted to `assertActive` — is **DELETED**, not gated: it had no consumer anywhere, and a
gated dead route keeps a payload alive for whoever finds it next while reading, in review, as a
considered decision about an audience. Its absence is asserted in `authz-cluster.e2e.spec.ts` for a
Workspace ADMIN, because a 404 for an Editor is also what a gate would produce and would prove
nothing.

**And the `permission` argument has to actually decide something.** It did not, for the membership half:
`listReadableProjectIds` unioned a raw `project_members` query in unconditionally, so every project the
caller held an active row on was readable **regardless of whether that row's access level granted the
permission being asked about**. It was written when membership was the only per-project fact and it
survived the move to `access_level`, by which point `effectiveAssignments` already synthesized the same
rows correctly filtered — so it was duplication for a permission the level grants, and a silent
over-grant for one it does not. What it opened: `portfolio:view`, which `editor` deliberately withholds,
so **every project Editor read every field of every Epic and Feature in their projects** — the one
surface `P5-PI-FR-017` and §3.2:85 hide from them. No other caller was affected, because the rest ask
for `project:view` or `work_item:view`, which is exactly why it stayed invisible. Membership now reaches
the result only through the permission-filtered synthesis; the generalisable rule is that **a boundary
taking a permission must not union in a source that ignores it**, and the failure reads as a boundary in
review. Two second-order effects, both deliberate: the synthesis filters on `isProjectAccessLevel` where
the deleted query used `isNotNull`, so an unrecognised level is no longer readable; and it rides the
5-minute assignment cache, so a membership row written by raw SQL is invisible to cross-project lists
until `invalidateUser` is called.

**Closing it needed the picker split in the same change**, and that is the pattern now, not a one-off:
the emptied list was also the only feed for the `Feature` field on a Story/Defect, so the fix is
`GET /portfolio-items/options` (id, key, name, project) gated on `work_item:view`. The BA is **SILENT**
on whether an Editor may set a Story's Feature, so this is a **declared reading** and has been put to
them: §5.2:124 makes that field the only way Feature membership is ever set, §3.2:79 gives an Editor the
Story, and the closest precedent is the BA's own one field over — `Phase 2/02_Iterations/SRS.md:393`,
"Timeboxes hidden; may update Work Item Iteration through approved Backlog/Iteration Status flows only"
— hidden surface, permitted field, therefore a feed. Release is decided the *other* way and says so in
words ("cannot assign Release", BL §8:294), which is why that one is refused in `WorkItemsService`
instead. **Where the BA wanted a field withheld from an Editor it wrote a sentence; it wrote none for
Feature.** If they rule it like Release, the reversal is this route plus one SPA field. The feed is
single-project per §5.3:133, which is what lets the GUARD check it (`{ from: 'query', field:
'projectId' }`) instead of a service-side narrowing — so the service deliberately makes **no**
authorization call, pinned by a spec. Note the API still *accepts* a cross-project Feature link
(`assertFeatureLinkable` permits it, because Rally's rollup matches `feature_id` alone) while the picker
no longer offers one: 0 such rows exist, and the BA's field scope wins over offering it.

**HOME's two aggregates were the last cross-project reads still scoped by `workspace_id` alone**, and
`GET /work-items/summary`'s own `@AuthorizedInService('scoped by listReadableProjectIds')` decorator
said otherwise — the identical false citation `listProjectHealth` carried until an e2e spec was written
for it. So after a Workspace Admin removed a user's access to a project, Home still reported that
project's active sprints, open work items, blocked items and open defects, and `My Work` still named its
items and project (`GAP-P4-RBAC-003`, against Phase 4 §2.2/§6, which put an unassigned project out of
"navigation, selectors, search **or results**"). `@SelfScoped` on `/work-items/my` was true and never
sufficient: *assigned to me* bounds whose the item is, not which project it may be read in, and an item
stays assigned after access is removed. Both now take `project:view` — the same code the projects list
and Project Health take, so the tile row, the list it links to and the health table cannot be counted in
three different populations. **A decorator is a note, not a check**; the four cases in
`work-items.service.spec.ts` are the check, and they assert BOTH sentinel directions, because a test
that only forwards an array also passes when `null` is flattened to `[]` — which fails closed and shows
a Workspace Admin all zeros.

-- Deleting a timebox must UNSCHEDULE its work, not orphan it.
--
-- THE DEFECT. `work_items.iteration_id`, `work.tasks.iteration_id`, `work_items.release_id` and
-- `portfolio_items.release_id` carried NO foreign key, and `IterationsService.deleteIteration` and
-- `ReleasesService.deleteRelease` are each a bare `repo.delete(id)` that unschedules nothing. So a
-- delete left every scheduled item pointing at a row that no longer existed. Reachable in normal
-- use: an iteration in `planning` legally holds items and is exactly the state the delete gate
-- permits. Verified by dropping these keys and re-running
-- `test/e2e/timebox-delete-unschedules.e2e.spec.ts`: three of its four cases fail.
--
-- The four `milestone_*` link tables are a DIFFERENT case, and a weaker one. They had no key either,
-- but `MilestoneDrizzleRepository.delete` already deletes all four junction rows in code before
-- deleting the milestone — so the service path never orphaned them, and the spec's milestone case
-- passes with or without the constraint below. The CASCADE is a backstop for the writers that
-- bypass the repository (`db/seeds/**`, raw SQL) and for the gap in the repository itself: those
-- four deletes and the milestone delete are five separate statements with no transaction around
-- them, so a failure between them used to leave links behind permanently. Worth having, but it is
-- defence in depth rather than the fix.
--
-- The 2026-08-04 full-stack audit called this its highest-value fix (§1.1) and it was still open.
--
-- WHAT IT SHOULD DO. Rally documents the target behaviour, and it is not "refuse": "If you delete an
-- iteration that stories and defects are scheduled in, **they will all be updated to unscheduled**."
-- The same holds for a release. For a milestone, deletion "removes the association from each work
-- item… The work item itself is not deleted" — so the LINK goes and the artifact stays.
--
-- Corroborated by Broadcom KB 143097, which exists *because* a deleted timebox leaves no live
-- reference: you have to reconstruct the affected set from Lookback `_PreviousValues`. That is the
-- shape of the bug being fixed here.
--
-- WHY A FOREIGN KEY AND NOT SERVICE CODE. `ON DELETE SET NULL` fires in the same statement as the
-- DELETE, so it is atomic without any transaction plumbing — and unlike a service it also covers
-- `db/seeds/**` and raw SQL, which write these tables directly. Same reasoning as
-- `trg_sync_accepted_date`, `trg_task_iteration_from_parent` and `timebox_group_id`: an invariant
-- belongs where every writer meets it. The delete methods now say so in a comment rather than
-- re-implementing it.
--
-- `work.tasks.iteration_id` gets its own key even though `trg_cascade_iteration_to_tasks` already
-- follows the parent. The trigger fires on an UPDATE of `work_items.iteration_id`, and the FK above
-- produces exactly that UPDATE, so the two agree — but a task whose parent link is broken, or a row
-- written directly by a seed, is only covered by having the key. The two cannot conflict: the
-- trigger re-derives from the parent, which is NULL by then, so both paths converge on NULL.
--
-- ORPHANS ARE CLEANED FIRST. Adding a key to a column that already has dangling values fails, and a
-- deployed database has had this defect for its whole life. Nulling them is the same repair the key
-- would have made at delete time; a dangling link is not information anyone can act on.

-- ── 1. Repair existing orphans ────────────────────────────────────────────────

UPDATE work.work_items w
   SET iteration_id = NULL
 WHERE w.iteration_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.iterations i WHERE i.id = w.iteration_id);

UPDATE work.tasks t
   SET iteration_id = NULL
 WHERE t.iteration_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.iterations i WHERE i.id = t.iteration_id);

UPDATE work.work_items w
   SET release_id = NULL
 WHERE w.release_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.releases r WHERE r.id = w.release_id);

UPDATE work.portfolio_items p
   SET release_id = NULL
 WHERE p.release_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work.releases r WHERE r.id = p.release_id);

DELETE FROM work.milestone_artifacts m
 WHERE NOT EXISTS (SELECT 1 FROM work.milestones x WHERE x.id = m.milestone_id);
DELETE FROM work.milestone_releases m
 WHERE NOT EXISTS (SELECT 1 FROM work.milestones x WHERE x.id = m.milestone_id);
DELETE FROM work.milestone_teams m
 WHERE NOT EXISTS (SELECT 1 FROM work.milestones x WHERE x.id = m.milestone_id);
DELETE FROM work.milestone_projects m
 WHERE NOT EXISTS (SELECT 1 FROM work.milestones x WHERE x.id = m.milestone_id);

-- ── 2. Scheduling links: SET NULL, i.e. "unscheduled" ─────────────────────────
--
-- Each is dropped by name first so the migration is idempotent.

ALTER TABLE work.work_items DROP CONSTRAINT IF EXISTS fk_wi_iteration;
ALTER TABLE work.work_items
  ADD CONSTRAINT fk_wi_iteration
  FOREIGN KEY (iteration_id) REFERENCES work.iterations(id) ON DELETE SET NULL;

ALTER TABLE work.tasks DROP CONSTRAINT IF EXISTS fk_tasks_iteration;
ALTER TABLE work.tasks
  ADD CONSTRAINT fk_tasks_iteration
  FOREIGN KEY (iteration_id) REFERENCES work.iterations(id) ON DELETE SET NULL;

ALTER TABLE work.work_items DROP CONSTRAINT IF EXISTS fk_wi_release;
ALTER TABLE work.work_items
  ADD CONSTRAINT fk_wi_release
  FOREIGN KEY (release_id) REFERENCES work.releases(id) ON DELETE SET NULL;

ALTER TABLE work.portfolio_items DROP CONSTRAINT IF EXISTS fk_portfolio_release;
ALTER TABLE work.portfolio_items
  ADD CONSTRAINT fk_portfolio_release
  FOREIGN KEY (release_id) REFERENCES work.releases(id) ON DELETE SET NULL;

-- ── 3. Milestone ASSOCIATIONS: CASCADE, i.e. the link goes, the artifact stays ─
--
-- CASCADE and not SET NULL because `milestone_id` is part of each link table's primary key: the row
-- IS the association, so there is no such thing as an association to no milestone. This is what
-- "removes the association from each work item" means, and the work item itself is untouched.

ALTER TABLE work.milestone_artifacts DROP CONSTRAINT IF EXISTS fk_milestone_artifacts_milestone;
ALTER TABLE work.milestone_artifacts
  ADD CONSTRAINT fk_milestone_artifacts_milestone
  FOREIGN KEY (milestone_id) REFERENCES work.milestones(id) ON DELETE CASCADE;

ALTER TABLE work.milestone_releases DROP CONSTRAINT IF EXISTS fk_milestone_releases_milestone;
ALTER TABLE work.milestone_releases
  ADD CONSTRAINT fk_milestone_releases_milestone
  FOREIGN KEY (milestone_id) REFERENCES work.milestones(id) ON DELETE CASCADE;

ALTER TABLE work.milestone_teams DROP CONSTRAINT IF EXISTS fk_milestone_teams_milestone;
ALTER TABLE work.milestone_teams
  ADD CONSTRAINT fk_milestone_teams_milestone
  FOREIGN KEY (milestone_id) REFERENCES work.milestones(id) ON DELETE CASCADE;

ALTER TABLE work.milestone_projects DROP CONSTRAINT IF EXISTS fk_milestone_projects_milestone;
ALTER TABLE work.milestone_projects
  ADD CONSTRAINT fk_milestone_projects_milestone
  FOREIGN KEY (milestone_id) REFERENCES work.milestones(id) ON DELETE CASCADE;

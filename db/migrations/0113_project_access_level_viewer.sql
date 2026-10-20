-- Restore `viewer` as a per-Project access level.
--
-- Migration 0104 created `work.project_members.access_level` with
-- `CHECK (access_level IS NULL OR access_level IN ('admin', 'editor'))`, matching the BA's
-- three-level model. The BA then removed `Viewer` outright (product-docs `55e7dbb`, 2026-08-14) and
-- an architect ruling on the same day RESTORED it, against that removal and in line with the product
-- being cloned: real Rally's `ProjectPermission.Role` is No Access / Viewer / Editor / Project
-- Admin, and its Viewer is the documented way to make a user read-only, the provisioning default
-- for a new user, a filter toggle on the admin permission grid, the demotion target in team
-- membership, and a full-licence consumer whose only purpose is access control. Without it a
-- read-only stakeholder or auditor has to be either invisible or a full Editor.
--
-- Declared in `docs/DIVERGENCE.md`. The permission SET for the level lives in code
-- (`ACCESS_LEVEL_PERMISSIONS` in `db/permissions.catalog.ts`) and is resolved per request by
-- `AccessService.effectiveAssignments`, so unlike a `system_roles` row it needs no data backfill —
-- there is no per-workspace copy to update. This migration only widens the constraint that would
-- otherwise reject the value.
--
-- NO ROWS CHANGE. Nobody is downgraded to `viewer` here, and in particular the rows migration 0104
-- step 3 mapped to `editor` — active members who had no role, and so previously conferred no access
-- at all — are deliberately left as they are. Re-reading that decision as "they meant viewer" would
-- be a silent revocation of write access for real people, months after the fact; if those rows are
-- wrong they should be corrected deliberately, per project, by a Workspace Admin who can see who
-- they are.
--
-- Idempotent: the constraint is dropped by name only if present, then re-added.
ALTER TABLE work.project_members
  DROP CONSTRAINT IF EXISTS chk_project_access_level;

ALTER TABLE work.project_members
  ADD CONSTRAINT chk_project_access_level
    CHECK (access_level IS NULL OR access_level IN ('admin', 'editor', 'viewer'));

-- Phase 7 (Story Date Tracking and Carryover) — `report:export` (rulings R1/R4, plan D4).
--
-- CSV export for the four reports (Iteration Burndown, Velocity, Team Capacity, Carryover) is gated by
-- a NEW project-tier permission, granted to Workspace Admin and Project Admin only — NOT to Project
-- Member (Editor). A declared divergence from CO-BR-03 ("no new permission"), recorded in CLAUDE.md.
--
-- Backfilled here for the reason 0092 / 0130 give: `db/seeds/bootstrap.ts` upserts the per-workspace
-- tier roles with `set: { name }`, so a catalogue addition never reaches an existing workspace. Global
-- templates (`workspace_id IS NULL`) are reseeded from the catalogue by `reference.ts` on every
-- migrate and need nothing here. The per-Project `admin` access level derives from the PROJECT_ADMIN
-- tier in code (`ACCESS_LEVEL_PERMISSIONS`), so it needs no row either.
--
-- Safe to FORCE rather than merge, and only because the code is new: nobody can have revoked a
-- permission that did not exist. The `NOT @>` guard keeps it idempotent.
--
-- WHY THE SLUG IS ENOUGH (PR #653 review, round 3). R4 excludes a "Read-only Project Admin", but no
-- such row can exist here: this access model has only the `admin` / `editor` project levels, and the
-- per-workspace role editor (`updateRolePermissions`) was removed, so a `project_admin` row cannot be
-- trimmed to read-only. Every `project_admin` row is a FULL admin (CLAUDE.md, Phase 7 divergence 1).
-- If a read-only planner is ever reintroduced, it needs its own slug — gating this grant on an
-- unrelated code such as `capacity:manage` would tie export to capacity planning by accident.
UPDATE access.system_roles
SET permissions = permissions || '["report:export"]'::jsonb
WHERE slug IN ('workspace_admin', 'project_admin')
  AND workspace_id IS NOT NULL
  AND NOT (permissions @> '["report:export"]'::jsonb);

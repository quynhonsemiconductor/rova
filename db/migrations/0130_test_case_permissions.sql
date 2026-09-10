-- Give the workspace-scoped tier roles the eight Phase 7 test_case:* / test_result:*
-- permissions (Phase 7 plan D3, A2).
--
-- The catalogue only reaches an EXISTING workspace through `db/seeds/bootstrap.ts`, whose
-- upsert is deliberately `set: { name }` — it must not clobber an admin's edits to a tier
-- role's permissions. Correct for edits, wrong for a brand-new permission: every workspace
-- created before this migration would otherwise keep its old array forever, and every
-- test-case route would answer 403 to everyone except Workspace Admin (whose grant is the
-- global `workspace:*` anchor) — the same failure `report:view` had (migration 0092).
--
-- Global system-role TEMPLATES (`workspace_id IS NULL`) need no backfill: `reference.ts`
-- reseeds them from the catalogue with a hard `set: { permissions, name }` on every
-- `pnpm db:migrate`, so they are always current. Only the per-workspace COPIES are frozen
-- at bootstrap time, which is what this migration targets.
--
-- All three tier roles get all eight codes: workspace_admin already grants everything via
-- `workspace:*`, but its stored row still lists every concrete code (catalogue's own
-- invariant — "no admin endpoint depends on the wildcard alone"), so it is backfilled here
-- too for consistency with the catalogue's ROLE_PERMISSIONS. project_admin and
-- project_member (Editor) both get all eight per the Phase 7 plan's explicit ruling (§4):
-- a Test Case is the same class of delivery artifact as a Story/Defect/Task, and the SRS
-- gives the tab no role restriction.
--
-- Safe to force rather than merge-if-absent-and-untouched, and only because these eight
-- codes are NEW: they did not exist before this migration, so no workspace can have
-- deliberately revoked one. The `NOT @>` guard keeps each statement idempotent for the
-- migration runner. No `updated_at` is set: `access.system_roles` has `created_at` only.
UPDATE access.system_roles
SET permissions = permissions || '["test_case:view", "test_case:create", "test_case:edit", "test_case:delete", "test_result:view", "test_result:create", "test_result:edit", "test_result:delete"]'::jsonb
WHERE slug IN ('workspace_admin', 'project_admin', 'project_member')
  AND workspace_id IS NOT NULL
  AND NOT (permissions @> '["test_case:view"]'::jsonb);

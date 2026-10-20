-- Remove `viewer` again. Reverses migration 0113 on the BA's instruction.
--
-- 0113 restored Viewer by architect ruling, against the BA's own removal
-- (`product-docs` `55e7dbb`, "remove viewer, no access permission"). That ruling was reversed on
-- 2026-08-14: the BA's three-level model stands, so the access levels are `admin` | `editor`, plus
-- implicit No Access when no active `project_members` row exists.
--
-- The disagreement is recorded rather than erased, because it will come up again. Real Rally's
-- `ProjectPermission.Role` IS No Access / Viewer / Editor / Project Admin, and its Viewer is the
-- documented way to make a user read-only, the provisioning default for a new user, one of four
-- filter toggles on the admin permission grid, the demotion target in team membership, and a
-- full-licence consumer whose only purpose is access control. With `admin`/`editor`/absent alone, a
-- read-only stakeholder or auditor is either invisible or a full Editor. Sourced evidence:
-- `product-docs/projects/mini-rally/09_Gap_Audit/research/RALLY_PERMISSIONS_MODEL.md`. See
-- `CLAUDE.md` → "Declared divergences from the BA, in the access model".
--
-- WHY THE ROWS CAN BE NULLED SAFELY, which is the only part that touches data. 0113 shipped on
-- branch `fix/authz-baseline-and-ratchet` and was never merged, so no deployed environment ever
-- accepted the value — any `viewer` row that exists is local development or test data. NULL (No
-- Access) rather than `editor` is the right landing for it: promoting a read-only grant to a write
-- grant to survive a schema change would be a silent privilege escalation, and the level's whole
-- point was that its holder cannot write. A Workspace Admin can re-grant deliberately.
--
-- Ordered nulling-then-narrowing, because the CHECK would reject the rows it is meant to exclude.
-- Idempotent: the UPDATE matches nothing on a database that never held the value, and the constraint
-- is dropped by name before being re-added.

UPDATE work.project_members
   SET access_level = NULL
 WHERE access_level = 'viewer';

ALTER TABLE work.project_members
  DROP CONSTRAINT IF EXISTS chk_project_access_level;

ALTER TABLE work.project_members
  ADD CONSTRAINT chk_project_access_level
    CHECK (access_level IS NULL OR access_level IN ('admin', 'editor'));

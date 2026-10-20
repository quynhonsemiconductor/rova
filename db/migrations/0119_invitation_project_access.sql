-- An invitation carries initial per-Project access (Settings §6.4, RBE-11).
--
-- Today inviting someone and granting them access are two unrelated actions, and only the first
-- is on the invite screen. The common path therefore produces a member who signs in and can see
-- nothing: `AccessService.effectiveAssignments` synthesizes a project grant from
-- `work.project_members` and there is no row, so the new joiner is indistinguishable from No
-- Access (§2.2, "implicit — no `project_members` row"). §6.4 puts the initial grant on the
-- invitation itself so accepting one lands a usable account in a single step.
--
-- A CHILD TABLE, not two columns on `workspace_invitations`, for three reasons:
--   * §6.4's list is per PROJECT, and an invitation may carry several. Two columns can carry one.
--   * The foreign keys are real. A hard-deleted project drops only its own grant row; with a
--     `project_id` column on the invitation there is nothing to cascade to, and the invitation
--     would stay pending while pointing at a project that no longer exists — half-valid, and it
--     would surface at ACCEPT time as a foreign-key error on a screen the invitee cannot fix.
--   * `ON DELETE cascade` from the invitation means cancelling or replacing one (resend rotates
--     the same row; a re-invite to the same address cancels the old one) cannot leave orphaned
--     intent behind.
--
-- NO BACKFILL IS OWED, and that is a deliberate statement rather than an omission: the ABSENCE of
-- a row IS today's behaviour. Every existing pending invitation grants no initial project access,
-- which is exactly what it did before this table existed, so there is nothing to preserve and
-- nothing to invent. Compare `0101_capacity_allocation_fixed_value.sql`, where a grain change
-- over existing rows had to freeze today's resolved value in the same migration — that rule
-- applies when a read path changes meaning, and here it does not.
--
-- `access_level varchar(10)` with the same CHECK values as `work.project_members.access_level`
-- (migration 0115 dropped `viewer`; see `db/permissions.catalog.ts` for why real Rally's Viewer
-- is a declared divergence). NOT NULL: an invitation row that names a project but no level would
-- have to be resolved to something at accept time, and a defaulted grant is the failure mode the
-- fixed-allocation work (0101) was written to remove. If the inviter has no level in mind they
-- add no row.
CREATE TABLE IF NOT EXISTS workspace.workspace_invitation_project_access (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  project_id    uuid NOT NULL,
  access_level  varchar(10) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_wipa_invitation FOREIGN KEY (invitation_id)
    REFERENCES workspace.workspace_invitations (id) ON DELETE CASCADE,
  CONSTRAINT fk_wipa_project FOREIGN KEY (project_id)
    REFERENCES work.projects (id) ON DELETE CASCADE,
  CONSTRAINT ck_wipa_access_level CHECK (access_level IN ('admin', 'editor'))
);

-- One level per (invitation, project). Two rows for the same project would make the grant
-- order-dependent, which is how "the same action produced a different level" bugs start.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wipa_invitation_project
  ON workspace.workspace_invitation_project_access (invitation_id, project_id);

-- The read is always "the rows for this invitation" (accept, and the pending-invite roster).
CREATE INDEX IF NOT EXISTS ix_wipa_invitation
  ON workspace.workspace_invitation_project_access (invitation_id);

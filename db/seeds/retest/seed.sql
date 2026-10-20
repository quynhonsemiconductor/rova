-- ============================================================================
-- RETEST-2026-08-18 — hand-run fixture for the BA's 2026-08-17/18 retest round
-- ============================================================================
-- WHAT THIS IS: a data set a human applies with psql, ONCE, to ONE environment
--   (develop), so the BA can re-walk GAP-P4-RBAC-003, P5-CP-013/030/035,
--   P6-VEL-004 and P6-IB-003/004 against real rows.
-- WHAT THIS IS NOT: a migration, and not part of `seed()` / `SEED_ON_DEPLOY`.
--   Migrations run on every deploy in every environment and can never be
--   un-run; the fixture tiers in `db/seeds/**` are gated for exactly that
--   reason (see CLAUDE.md, "Seeds: what a DEPLOYED database is allowed to
--   contain"). This file is deliberately wired into NOTHING: it is applied by
--   hand, it is idempotent, and `db/seeds/retest/reset.sql` removes it again,
--   scoped to the two retest projects and two retest teams and never
--   TRUNCATEing. Do not import it, schedule it, or call it from migrate.ts.
--
-- RUN:      psql "$DEVELOP_URL" -v ON_ERROR_STOP=1 -f db/seeds/retest/seed.sql
-- RE-RUN:   safe. Every write is ON CONFLICT DO NOTHING, or DO UPDATE where a
--           re-run must RESTORE a value the BA's own actions changed (a
--           published plan back to Draft, a published Feature's Release back to
--           NULL). Running it twice changes no row count.
-- REMOVE:   psql "$DEVELOP_URL" -v ON_ERROR_STOP=1 -f db/seeds/retest/reset.sql
-- HANDOFF:  psql "$DEVELOP_URL" -f db/seeds/retest/mapping.sql   (ids + deep links)
--
-- Every id is in the block 00000000-0000-7000-8000-00000000f0XX, which cannot
-- collide with the demo seed's 00000000-0000-7000-8000-0000000000XX block, and
-- every name/title carries the literal RETEST-2026-08-18 so a human can find
-- and audit the rows.
-- ============================================================================

-- ── EDIT THESE, then run ────────────────────────────────────────────────────
-- THREE are required; `unassigned_email` is OPTIONAL — leave it as the
-- `change-me` default (or empty) to skip it.
--
-- Optional because the seed writes NOTHING for that account: "No Access" is the
-- ABSENCE of a `project_members` row, so there is nothing to grant and nothing
-- to name. Requiring a fourth principal would only have forced a new company
-- account into existence to satisfy a guard. The BA's own plan already covers
-- the case the other way round — "Bằng WA, remove TEST access của <editor>" —
-- so the unassigned session is made by REMOVING access from an account that has
-- it, not by seeding a spare one.
--
-- Each address given must have signed in through Entra at least once: that first
-- SSO login is what creates its `identity.users` row, which SQL cannot do. The
-- guard below ABORTS the whole transaction (nothing written) and names any
-- address it cannot find, because a half-seeded RBAC group is worse than none.
--
-- This file grants PER-PROJECT access only (`project_members.access_level`),
-- which is what `AccessService.effectiveAssignments` synthesizes a project grant
-- from. It grants NO workspace-tier role: the wa_email account must already hold
-- Workspace Admin (`access.user_role_assignments`), given through User
-- Management by an existing admin. A first SSO login only gives the default
-- role, so an unprepared wa_email account will read like the Project Admin one.
--
-- EDIT THE LINES BELOW. A command-line `-v wa_email=…` does NOT win: psql
-- keeps the LAST assignment and these `\set`s run after it (verified). Deleting a
-- line instead of editing it is not a softer option either — an unset variable is
-- left uninterpolated and the INSERT fails with a bare syntax error, before the
-- guard can name anything.
\set wa_email 'change-me@qnsc.vn'
\set pa_email 'change-me@qnsc.vn'
\set editor_email 'change-me@qnsc.vn'
\set unassigned_email 'change-me@qnsc.vn'

BEGIN;

-- ============================================================================
-- 0. ACCOUNTS + THE GUARD
-- ============================================================================
-- The temp table is session-only and `ON COMMIT DROP`, so the three statements
-- before the guard write NOTHING that outlives this transaction — the guard is
-- still the first thing that can stop a single persistent row being written.
CREATE TEMP TABLE retest_accounts (
  role    text PRIMARY KEY,
  email   text,          -- nullable on purpose: an unset \set must be REPORTED,
  user_id uuid           -- not raise a NOT NULL violation nobody can read.
) ON COMMIT DROP;

INSERT INTO retest_accounts (role, email) VALUES
  ('wa',         :'wa_email'),
  ('pa',         :'pa_email'),
  ('editor',     :'editor_email'),
  ('unassigned', :'unassigned_email');

-- Case-insensitive, because an IdP may return a differently-cased local part
-- for the same mailbox (the same reason INVITATION_EMAIL_MISMATCH compares
-- case-insensitively).
-- An untouched placeholder is the same statement as an empty one: "not provided".
-- Normalised to NULL first so every check below reads one representation.
UPDATE retest_accounts
   SET email = NULL
 WHERE email IS NULL OR btrim(email) = '' OR lower(email) LIKE 'change-me@%';

UPDATE retest_accounts a
   SET user_id = u.id
  FROM identity.users u
 WHERE lower(u.email) = lower(a.email);

DO $guard$
DECLARE
  missing  text;
  outside  text;
  dupes    text;
BEGIN
  -- `unassigned` is exempt: it may legitimately be absent (see the header). The other
  -- three are what the RBAC group is made of, so an unresolved one aborts.
  SELECT string_agg(format('%s=%s', role, coalesce(email, '<not provided>')), ', ' ORDER BY role)
    INTO missing
    FROM retest_accounts
   WHERE user_id IS NULL
     AND (role <> 'unassigned' OR email IS NOT NULL);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'RETEST-2026-08-18 seed aborted: no identity.users row for %', missing
      USING HINT = 'Have each address sign in through Entra SSO once (that login creates the user row), then re-run. Nothing was written.';
  END IF;

  -- A user row is not enough: every one of the four must also be an ACTIVE member of
  -- this workspace. `assertActive` refuses a suspended or removed member at the door,
  -- so such an account cannot log in at all — and the `unassigned` case would then pass
  -- for the WRONG REASON. "Sees no projects because they hold no project access" is the
  -- rule under retest; "sees nothing because the session is refused" proves nothing and
  -- looks identical on screen. Caught here rather than discovered mid-retest.
  SELECT string_agg(format('%s=%s', a.role, a.email), ', ' ORDER BY a.role)
    INTO outside
    FROM retest_accounts a
    LEFT JOIN workspace.workspace_members m
           ON m.user_id = a.user_id
          AND m.workspace_id = '00000000-0000-7000-8000-000000000003'::uuid
          AND m.status = 'active'
   WHERE m.user_id IS NULL
     AND a.user_id IS NOT NULL;

  IF outside IS NOT NULL THEN
    RAISE EXCEPTION 'RETEST-2026-08-18 seed aborted: not an ACTIVE member of this workspace: %', outside
      USING HINT = 'Each of the four needs an active workspace.workspace_members row — a company account they can actually sign in with. The unassigned account needs that too: it must be able to log IN and see nothing, which is not the same as being unable to log in. Nothing was written.';
  END IF;

  -- Four DISTINCT people, or the RBAC group cannot demonstrate anything: one
  -- address used twice would silently give one principal two access levels
  -- (uq_project_member is per project+user) and the "unassigned" case would be
  -- a member.
  SELECT string_agg(DISTINCT lower(email), ', ') INTO dupes
    FROM retest_accounts
   WHERE email IS NOT NULL
     AND lower(email) IN (
       SELECT lower(email) FROM retest_accounts
        WHERE email IS NOT NULL
        GROUP BY lower(email) HAVING count(*) > 1
     );

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'RETEST-2026-08-18 seed aborted: the four accounts must be four DIFFERENT people; repeated: %', dupes
      USING HINT = 'wa_email, pa_email, editor_email and unassigned_email must all differ. Nothing was written.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM retest_accounts WHERE role = 'unassigned' AND email IS NOT NULL) THEN
    RAISE NOTICE 'RETEST-2026-08-18: no unassigned account supplied. Nothing is seeded for that role by design — make the unassigned session by REMOVING an account''s project access (the BA''s own step), not by expecting a row here.';
  END IF;
END
$guard$;

-- ============================================================================
-- 0b. PRE-FLIGHT: THIS IS NOT AN EMPTY DATABASE
-- ============================================================================
-- Develop already holds rows people made through the UI, and every key this
-- fixture claims is unique per WORKSPACE (`uq_projects_workspace_key`,
-- `uq_teams_key`, `uq_wi_item_key`, `uq_portfolio_item_key`). So if anyone has
-- already used one of these keys, an `ON CONFLICT (id) DO NOTHING` does NOT
-- protect us: the id is free, the KEY is taken, and Postgres raises
--   duplicate key value violates unique constraint "uq_projects_workspace_key"
-- from the middle of the file with nothing to say about which fixture it was or
-- what to do next. Verified by reproducing exactly that.
--
-- So the collision is found FIRST, named, and nothing is written. The check is
-- "same key, DIFFERENT id", which is precisely the unsafe case: same key AND
-- same id is our own previous run, and that is what makes re-running safe.
--
-- The workspace row is checked for the same reason. `db/seeds/bootstrap.ts`
-- writes this id in every environment on every deploy, so its absence means the
-- connection is pointed somewhere unexpected — better to say so than to fail
-- later on a foreign key.
DO $preflight$
DECLARE
  clashes text;
  ws_ok   boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM workspace.workspaces
     WHERE id = '00000000-0000-7000-8000-000000000003'::uuid
  ) INTO ws_ok;

  IF NOT ws_ok THEN
    RAISE EXCEPTION 'RETEST-2026-08-18 seed aborted: workspace 00000000-0000-7000-8000-000000000003 does not exist here'
      USING HINT = 'That id is written by db/seeds/bootstrap.ts on every deploy. Check which database this connection points at. Nothing was written.';
  END IF;

  WITH expected(kind, key, id) AS (
    VALUES
      ('project', 'RBACA',   '00000000-0000-7000-8000-00000000f001'),
      ('project', 'RBACHID', '00000000-0000-7000-8000-00000000f002'),
      ('team',    'RTEAMA',  '00000000-0000-7000-8000-00000000f020'),
      ('team',    'RTEAMB',  '00000000-0000-7000-8000-00000000f021')
  ),
  found AS (
    SELECT e.kind, e.key, p.id::text AS existing
      FROM expected e
      JOIN work.projects p
        ON p.workspace_id = '00000000-0000-7000-8000-000000000003'::uuid
       AND p.key = e.key
     WHERE e.kind = 'project' AND p.id::text <> e.id
    UNION ALL
    SELECT e.kind, e.key, t.id::text
      FROM expected e
      JOIN work.teams t
        ON t.workspace_id = '00000000-0000-7000-8000-000000000003'::uuid
       AND t.key = e.key
     WHERE e.kind = 'team' AND t.id::text <> e.id
    UNION ALL
    -- Work items and portfolio items: any RETEST key already held by a row that
    -- is not ours. The prefix is the fixture's own namespace, so a hit here means
    -- a hand-made row is wearing a fixture key.
    SELECT 'work item', w.item_key, w.id::text
      FROM work.work_items w
     WHERE w.workspace_id = '00000000-0000-7000-8000-000000000003'::uuid
       AND w.item_key LIKE '%-SEED-%'
       AND w.id::text NOT LIKE '00000000-0000-7000-8000-00000000f0%'
    UNION ALL
    SELECT 'portfolio item', pi.item_key, pi.id::text
      FROM work.portfolio_items pi
     WHERE pi.workspace_id = '00000000-0000-7000-8000-000000000003'::uuid
       AND pi.item_key LIKE '%-SEED-%'
       AND pi.id::text NOT LIKE '00000000-0000-7000-8000-00000000f0%'
  )
  SELECT string_agg(format('%s %s held by %s', kind, key, existing), '; ' ORDER BY kind, key)
    INTO clashes
    FROM found;

  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'RETEST-2026-08-18 seed aborted: key(s) already in use by rows this fixture does not own: %', clashes
      USING HINT = 'Something else already uses these keys. Rename or remove those rows, or edit the fixture keys, then re-run. Nothing was written.';
  END IF;
END
$preflight$;

-- The Burndown x-axis is WORKING days in the WORKSPACE's own timezone, so the
-- seeded snapshot dates only render if this workspace agrees with the assumption
-- they were chosen under (Mon-Fri). Reported rather than enforced: a different
-- calendar is a legitimate configuration, and the operator needs to know that
-- 08-13/08-14/08-17/08-18 are the days to look for.
DO $calendar$
DECLARE
  tz   text;
  days smallint[];
BEGIN
  SELECT timezone, working_days INTO tz, days
    FROM workspace.workspace_settings
   WHERE workspace_id = '00000000-0000-7000-8000-000000000003'::uuid;

  RAISE NOTICE 'RETEST-2026-08-18: workspace timezone=% working_days=% — snapshot days are 2026-08-13, 08-14, 08-17, 08-18 (all Mon-Fri). If working_days excludes any of them, that day is stored but never plotted.',
    coalesce(tz, '(no settings row)'), coalesce(days::text, '(default Mon-Fri)');
END
$calendar$;

-- ============================================================================
-- GROUP A — GAP-P4-RBAC-003: Editor team scope, and the Project Backlog
-- ============================================================================
-- RBACA   is granted (Project Admin = admin, Editor = editor on Team A only)
-- RBACHID is granted to NOBODY: the Workspace Admin reaches it through the
--         workspace-wide grant, which is the whole point — a project a
--         principal holds no row on must be absent from navigation, selectors,
--         search, results and direct URLs (Phase 4 §2.2/§6).
--
-- `lead_id` / `created_by` / `actor_id` below are the RESOLVED Workspace Admin,
-- not `ADMIN_USER_ID` ('00000000-0000-7000-8000-000000000002' in
-- db/seeds/constants.ts). That constant is created by the DEMO tier, which does
-- not run on develop (`SEED_ON_DEPLOY=false`, and NODE_ENV=production refuses it
-- outright), so authoring every row to it would name a user that does not exist
-- there — blank "Created By", an actor-less Revision History. WORKSPACE_ID
-- ('00000000-0000-7000-8000-000000000003') IS hard-coded from that same file:
-- the BOOTSTRAP tier writes it in every environment on every deploy.
INSERT INTO work.projects (id, workspace_id, key, name, description, lead_id, status)
SELECT v.id, '00000000-0000-7000-8000-000000000003'::uuid, v.key, v.name, v.description,
       (SELECT user_id FROM retest_accounts WHERE role = 'wa'), 'active'::project_status
  FROM (VALUES
    ('00000000-0000-7000-8000-00000000f001'::uuid, 'RBACA',
     'RETEST-2026-08-18 RBAC Granted Project',
     'RETEST-2026-08-18 (GAP-P4-RBAC-003). Project Admin and Editor both hold access here; the Editor is on Team A only.'),
    ('00000000-0000-7000-8000-00000000f002'::uuid, 'RBACHID',
     'RETEST-2026-08-18 RBAC Hidden Project',
     'RETEST-2026-08-18 (GAP-P4-RBAC-003). NO project_members rows at all: only a Workspace Admin may reach it.')
  ) AS v(id, key, name, description)
ON CONFLICT (id) DO NOTHING;

-- The four default workflow statuses per project, mirroring `seedProject` in
-- db/seeds/demo.ts (DEFAULT_WORKFLOW_STATUSES). `work_items.status_id` is NOT
-- NULL, so these must exist before any item. Fixed ids because the table has no
-- unique key on (project_id, name) — an id is the only thing that makes the
-- insert idempotent.
INSERT INTO work.workflow_statuses (id, workspace_id, project_id, name, category, color, position, is_default)
SELECT v.id, '00000000-0000-7000-8000-000000000003'::uuid, v.project_id, v.name,
       v.category::workflow_status_category, v.color, v.position, v.is_default
  FROM (VALUES
    ('00000000-0000-7000-8000-00000000f010'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid, 'Defined',     'to_do',       '#6B7280', 0, true),
    ('00000000-0000-7000-8000-00000000f011'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid, 'In Progress', 'in_progress', '#3B82F6', 1, false),
    ('00000000-0000-7000-8000-00000000f012'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid, 'Completed',   'done',        '#10B981', 2, false),
    ('00000000-0000-7000-8000-00000000f013'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid, 'Accepted',    'done',        '#059669', 3, false),
    ('00000000-0000-7000-8000-00000000f014'::uuid, '00000000-0000-7000-8000-00000000f002'::uuid, 'Defined',     'to_do',       '#6B7280', 0, true),
    ('00000000-0000-7000-8000-00000000f015'::uuid, '00000000-0000-7000-8000-00000000f002'::uuid, 'In Progress', 'in_progress', '#3B82F6', 1, false),
    ('00000000-0000-7000-8000-00000000f016'::uuid, '00000000-0000-7000-8000-00000000f002'::uuid, 'Completed',   'done',        '#10B981', 2, false),
    ('00000000-0000-7000-8000-00000000f017'::uuid, '00000000-0000-7000-8000-00000000f002'::uuid, 'Accepted',    'done',        '#059669', 3, false)
  ) AS v(id, project_id, name, category, color, position, is_default)
ON CONFLICT (id) DO NOTHING;

-- Two teams, BOTH actively linked to RBACA. `assertTeamInScope` needs an active
-- roster row on a team actively LINKED to the project, and the picker feed
-- (`ProjectTeamDrizzleRepository`) requires `teams.status = 'active'` as well —
-- read a `status` column twice: the link has one and the team has one.
INSERT INTO work.teams (id, workspace_id, name, key, description, lead_id, status)
SELECT v.id, '00000000-0000-7000-8000-000000000003'::uuid, v.name, v.key, v.description,
       (SELECT user_id FROM retest_accounts WHERE role = 'wa'), 'active'::team_status
  FROM (VALUES
    ('00000000-0000-7000-8000-00000000f020'::uuid, 'RETEST-2026-08-18 Team A', 'RTEAMA',
     'RETEST-2026-08-18. The Editor account is a member of THIS team only.'),
    ('00000000-0000-7000-8000-00000000f021'::uuid, 'RETEST-2026-08-18 Team B', 'RTEAMB',
     'RETEST-2026-08-18. The Editor is NOT a member: its records must be refused with TEAM_NOT_IN_SCOPE.')
  ) AS v(id, name, key, description)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work.project_teams (id, workspace_id, project_id, team_id, status)
VALUES
  ('00000000-0000-7000-8000-00000000f022', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-00000000f020', 'active'),
  ('00000000-0000-7000-8000-00000000f023', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-00000000f021', 'active')
ON CONFLICT (id) DO NOTHING;

-- Team A roster: the Editor, and nobody else. RBE-06 reads an Editor's scope
-- from exactly this row.
INSERT INTO work.team_members (id, workspace_id, team_id, user_id, status)
SELECT '00000000-0000-7000-8000-00000000f024'::uuid,
       '00000000-0000-7000-8000-000000000003'::uuid,
       '00000000-0000-7000-8000-00000000f020'::uuid,
       (SELECT user_id FROM retest_accounts WHERE role = 'editor'),
       'active'::team_member_status
ON CONFLICT (id) DO NOTHING;

-- Project access. THREE deliberate absences:
--   • the Workspace Admin gets NO row — §2.1/AC-8 and migration 0118, which
--     deletes exactly this row; `AccessService.effectiveAssignments` would turn
--     it into a live Project Admin grant the moment the WA were demoted, and no
--     roster displays it (CLAUDE.md, "a value HIDDEN on read").
--   • the unassigned account gets no row ANYWHERE: No Access is the ABSENCE of
--     a row, never a stored value.
--   • nobody gets a row on RBACHID.
INSERT INTO work.project_members (id, workspace_id, project_id, user_id, status, access_level)
SELECT v.id, '00000000-0000-7000-8000-000000000003'::uuid,
       '00000000-0000-7000-8000-00000000f001'::uuid,
       (SELECT user_id FROM retest_accounts WHERE role = v.role),
       'active'::project_member_status, v.access_level
  FROM (VALUES
    ('00000000-0000-7000-8000-00000000f025'::uuid, 'pa',     'admin'),
    ('00000000-0000-7000-8000-00000000f026'::uuid, 'editor', 'editor')
  ) AS v(id, role, access_level)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 1. KEY COUNTERS
-- ============================================================================
-- "A seeded key must also advance the counter, or the app mints it again and
-- collides on the next create" (CLAUDE.md). Two different mechanisms mint keys
-- in this app, and only one of them is this table:
--   • WORK ITEMS come from `workspace_item_counters` via `incrementCounter`
--     (US-1, DE-2, …), so the row must EXIST for a create to succeed. The
--     GREATEST upsert below is the demo seed's idiom; the value is 0 because no
--     retest key consumes an ordinal — they are all suffix-named
--     (US-SEED-MOVE), so they cannot collide with US-<n> at any n.
--   • PORTFOLIO ITEMS, RELEASES, ITERATIONS, MILESTONES and CAPACITY PLANS
--     have no counter row at all: their next key is
--     `MAX(substring(key from '[0-9]+$')) + 1` over the workspace. That is why
--     NO key in this file ends in a digit — `FE-SEED-2026` would push the next
--     minted Feature to FE-2027. `item_type` is the `work_item_type` enum
--     (story|task|defect), so an epic/feature counter cannot even be written.
INSERT INTO work.workspace_item_counters (workspace_id, item_type, last_item_number)
VALUES
  ('00000000-0000-7000-8000-000000000003', 'story',  0),
  ('00000000-0000-7000-8000-000000000003', 'defect', 0),
  ('00000000-0000-7000-8000-000000000003', 'task',   0)
ON CONFLICT (workspace_id, item_type) DO UPDATE
  SET last_item_number = GREATEST(work.workspace_item_counters.last_item_number, EXCLUDED.last_item_number);

-- ============================================================================
-- 2. RELEASES — THREE, because a plan is one per (project, release)
-- ============================================================================
-- `uq_capacity_plan_project_release` allows exactly ONE plan per (project,
-- release). The BA's document names two releases for three plans, so
-- RE-SEED-WARN is an addition: without it the warning plan and one of the
-- publish plans would have to share a release, and the second insert would
-- simply fail.
INSERT INTO work.releases (id, workspace_id, project_id, release_key, name, description,
                           status, start_date, release_date, target_date, planned_velocity, plan_estimate, version)
VALUES
  ('00000000-0000-7000-8000-00000000f030', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'RE-SEED-WARN',
   'RETEST-2026-08-18 Release for the capacity WARNING plan',
   'RETEST-2026-08-18 (P5-CP-013/030). Dates match CP-SEED-WARN exactly, so a publish here is about the numbers, not the window.',
   'planning', '2026-08-01', '2026-08-31', '2026-08-31', 11, 12, 'r-warn'),
  ('00000000-0000-7000-8000-00000000f031', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'RE-SEED-EXACT',
   'RETEST-2026-08-18 Release with dates the plan MATCHES',
   'RETEST-2026-08-18 (P5-CP-035). 2026-09-01..2026-09-30 — identical to CP-SEED-EXACT, so publish WRITES the Release onto the Feature.',
   'planning', '2026-09-01', '2026-09-30', '2026-09-30', 5, 5, 'r-exact'),
  ('00000000-0000-7000-8000-00000000f032', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'RE-SEED-MISMATCH',
   'RETEST-2026-08-18 Release with dates the plan does NOT match',
   'RETEST-2026-08-18 (P5-CP-035). 2026-10-01..2026-10-31 against a plan of 2026-10-05..2026-10-25: inside the release, and still not EQUAL, which is the case AC-019 refuses.',
   'planning', '2026-10-01', '2026-10-31', '2026-10-31', 7, 7, 'r-mismatch')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 3. FEATURES (Portfolio Items)
-- ============================================================================
-- `release_id`, `planned_start_date` and `planned_end_date` are seeded NULL and
-- RESTORED to NULL on a re-run (ON CONFLICT DO UPDATE below): publishing a plan
-- writes all three (`applyPlanToFeature`) and Unpublish does not roll them back
-- by contract, so re-running this file is how the BA re-arms a publish test.
-- Nothing else about a Feature is overwritten — a re-run must not discard an
-- edit the BA made deliberately.
--
-- `refined_estimate` stays 0 and every allocation is `source = 'manual'`: the
-- numbers below are deliberate planning values (SRS §186), not a copy of a
-- Feature forecast, and `Feature Estimated` resolves from Total Allocated
-- anyway (AC-014).
INSERT INTO work.portfolio_items (id, workspace_id, project_id, item_key, type, name, description,
                                  state, preliminary_estimate, refined_estimate, team_id, release_id,
                                  planned_start_date, planned_end_date, rank)
VALUES
  ('00000000-0000-7000-8000-00000000f040', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'FE-SEED-WARN-A', 'feature',
   'RETEST-2026-08-18 Warning plan Feature A',
   'RETEST-2026-08-18 (P5-CP-013/030). Team A allocation 5; children roll up 8 with 3 complete, so Rollup EXCEEDS Estimated.',
   'developing', 'no_entry', 0, '00000000-0000-7000-8000-00000000f020', NULL, NULL, NULL, 'r0010'),
  ('00000000-0000-7000-8000-00000000f041', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'FE-SEED-WARN-B', 'feature',
   'RETEST-2026-08-18 Warning plan Feature B',
   'RETEST-2026-08-18 (P5-CP-013/030). Team B allocation 7 against a capacity of 5, and 0 of its 4 rolled-up points complete.',
   'developing', 'no_entry', 0, '00000000-0000-7000-8000-00000000f021', NULL, NULL, NULL, 'r0020'),
  ('00000000-0000-7000-8000-00000000f042', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'FE-SEED-EXACT', 'feature',
   'RETEST-2026-08-18 Exact-window Feature',
   'RETEST-2026-08-18 (P5-CP-035). Split across Team A (primary) and Team B. No Release yet: publishing CP-SEED-EXACT must write RE-SEED-EXACT here.',
   'developing', 'no_entry', 0, '00000000-0000-7000-8000-00000000f020', NULL, NULL, NULL, 'r0030'),
  ('00000000-0000-7000-8000-00000000f043', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'FE-SEED-MISMATCH', 'feature',
   'RETEST-2026-08-18 Mismatched-window Feature',
   'RETEST-2026-08-18 (P5-CP-035). Split across Team A (primary) and Team B, release_id NULL so the advisory is release_span_mismatch and not other_release.',
   'developing', 'no_entry', 0, '00000000-0000-7000-8000-00000000f020', NULL, NULL, NULL, 'r0040')
ON CONFLICT (id) DO UPDATE
  SET release_id         = EXCLUDED.release_id,
      planned_start_date = EXCLUDED.planned_start_date,
      planned_end_date   = EXCLUDED.planned_end_date;

-- ============================================================================
-- 4. ITERATIONS (Group C) — before the work items that point at them
-- ============================================================================
-- There is NO `completed` iteration state: the enum is planning|committed|
-- accepted, so a "Completed Iteration" is `accepted` with a past end_date.
-- `timebox_group_id` is deliberately NOT set — `trg_sync_timebox_group_id`
-- (migration 0093) derives it from (project, start, end), and the trigger
-- exists precisely because raw SQL writes this table.
INSERT INTO work.iterations (id, workspace_id, project_id, iteration_key, name, goal, state,
                             start_date, end_date, team_id, planned_velocity, completed_at)
VALUES
  ('00000000-0000-7000-8000-00000000f070', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'IT-SEED-COMPLETED',
   'RETEST-2026-08-18 Completed Iteration',
   'RETEST-2026-08-18 (P6-VEL-004). Finished and EMPTY: move US-SEED-MOVE into it and the Velocity bar must appear.',
   'accepted', '2026-08-01', '2026-08-07', '00000000-0000-7000-8000-00000000f020', 8,
   '2026-08-07T17:00:00+00'),
  ('00000000-0000-7000-8000-00000000f071', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', 'IT-SEED-SNAPSHOT',
   'RETEST-2026-08-18 Snapshot Iteration',
   'RETEST-2026-08-18 (P6-IB-003/004). Window 2026-08-10..2026-08-21 CONTAINS every seeded snapshot date; frozen history and a per-team baseline live here.',
   'accepted', '2026-08-10', '2026-08-21', '00000000-0000-7000-8000-00000000f020', 8,
   '2026-08-21T17:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 5. WORK ITEMS
-- ============================================================================
-- BR-WI-01: `flow_state` MIRRORS `schedule_state`. `status_id` is the project's
-- own workflow status matching that state (Defined / In Progress / Completed /
-- Accepted), which is why the statuses above are inserted with fixed ids.
--
-- The FOURTH Group A row (US-SEED-RBAC-BACKLOG, `team_id IS NULL`) is NOT in
-- the BA's document and is required: since 2026-08-17 a team-less work row is
-- the PROJECT BACKLOG, admin-only, and it is the only way to see an Editor get
-- PROJECT_BACKLOG_ADMIN_ONLY where the Project Admin gets the record. Without
-- it the retest cannot tell "you may not open that" from "that is someone
-- else's team" — two different refusals, one of which the reader can act on.
INSERT INTO work.work_items (id, workspace_id, project_id, item_key, type, title, description,
                             status_id, schedule_state, flow_state, priority, team_id, iteration_id,
                             feature_id, story_points, accepted_date, created_by, rank)
SELECT v.id, '00000000-0000-7000-8000-000000000003'::uuid, v.project_id, v.item_key, 'story'::work_item_type,
       v.title, v.description, v.status_id, v.schedule_state::work_item_schedule_state,
       v.schedule_state::work_item_schedule_state, 'normal'::work_item_priority,
       v.team_id, v.iteration_id, v.feature_id, v.story_points, v.accepted_date,
       (SELECT user_id FROM retest_accounts WHERE role = 'wa'), v.rank
  FROM (VALUES
    -- ── Group A: the four RBAC populations ────────────────────────────────
    ('00000000-0000-7000-8000-00000000f080'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-RBAC-TEAMA', 'RETEST-2026-08-18 Team A story - Editor IS in scope',
     'RETEST-2026-08-18 (GAP-P4-RBAC-003 AC#3). The Editor is on Team A, so this record, its activity, attachments and comments are all readable.',
     '00000000-0000-7000-8000-00000000f010'::uuid, 'defined', '00000000-0000-7000-8000-00000000f020'::uuid,
     NULL::uuid, NULL::uuid, 3::numeric, NULL::timestamptz, 'r1010'),
    ('00000000-0000-7000-8000-00000000f081'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-RBAC-TEAMB', 'RETEST-2026-08-18 Team B story - Editor is NOT in scope',
     'RETEST-2026-08-18 (GAP-P4-RBAC-003 AC#3). Another team inside the same project: TEAM_NOT_IN_SCOPE for the Editor, readable for the Project Admin.',
     '00000000-0000-7000-8000-00000000f010'::uuid, 'defined', '00000000-0000-7000-8000-00000000f021'::uuid,
     NULL::uuid, NULL::uuid, 3::numeric, NULL::timestamptz, 'r1020'),
    ('00000000-0000-7000-8000-00000000f082'::uuid, '00000000-0000-7000-8000-00000000f002'::uuid,
     'US-SEED-RBAC-HIDDEN', 'RETEST-2026-08-18 Hidden-project story - Workspace Admin only',
     'RETEST-2026-08-18 (GAP-P4-RBAC-003 AC#4/#5). In RBACHID, which has no project_members rows and no linked teams: absent from every list, selector, search result and deep link for the other three accounts.',
     '00000000-0000-7000-8000-00000000f014'::uuid, 'defined', NULL::uuid,
     NULL::uuid, NULL::uuid, 3::numeric, NULL::timestamptz, 'r1030'),
    ('00000000-0000-7000-8000-00000000f083'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-RBAC-BACKLOG', 'RETEST-2026-08-18 Project Backlog story - team_id IS NULL',
     'RETEST-2026-08-18 (NOT in the BA doc; added deliberately). team_id NULL is the Project Backlog: PROJECT_BACKLOG_ADMIN_ONLY for the Editor, readable for Workspace Admin and per-project Admin.',
     '00000000-0000-7000-8000-00000000f010'::uuid, 'defined', NULL::uuid,
     NULL::uuid, NULL::uuid, 3::numeric, NULL::timestamptz, 'r1040'),
    -- ── Group B: the WARNING plan's children ──────────────────────────────
    -- Each child carries its OWN team, which is what puts it in the intended
    -- slice: `teamSliceChildScope` attributes a child to its own team when that
    -- team holds an allocation of the Feature on this plan, and otherwise falls
    -- back to the Feature's PRIMARY allocation. Setting the column is the
    -- simplest correct answer and it makes the team slices sum to the Feature's
    -- own totals (AC-017) without relying on the fallback.
    ('00000000-0000-7000-8000-00000000f084'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-WARN-A-DONE', 'RETEST-2026-08-18 Warning A child - completed',
     'RETEST-2026-08-18 (P5-CP-029/030). 3 points, completed: the whole of Feature A''s Complete.',
     '00000000-0000-7000-8000-00000000f012'::uuid, 'completed', '00000000-0000-7000-8000-00000000f020'::uuid,
     NULL::uuid, '00000000-0000-7000-8000-00000000f040'::uuid, 3::numeric, NULL::timestamptz, 'r1050'),
    ('00000000-0000-7000-8000-00000000f085'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-WARN-A-WIP', 'RETEST-2026-08-18 Warning A child - in progress',
     'RETEST-2026-08-18 (P5-CP-029/030). 5 points, in progress. Carries NO Release of its own, which is exactly the shape that used to report Rollup 0.',
     '00000000-0000-7000-8000-00000000f011'::uuid, 'in_progress', '00000000-0000-7000-8000-00000000f020'::uuid,
     NULL::uuid, '00000000-0000-7000-8000-00000000f040'::uuid, 5::numeric, NULL::timestamptz, 'r1060'),
    ('00000000-0000-7000-8000-00000000f086'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-WARN-B-WIP', 'RETEST-2026-08-18 Warning B child - in progress',
     'RETEST-2026-08-18 (P5-CP-029/030). 2 of Feature B''s 4 rolled-up points, none of them complete.',
     '00000000-0000-7000-8000-00000000f011'::uuid, 'in_progress', '00000000-0000-7000-8000-00000000f021'::uuid,
     NULL::uuid, '00000000-0000-7000-8000-00000000f041'::uuid, 2::numeric, NULL::timestamptz, 'r1070'),
    ('00000000-0000-7000-8000-00000000f087'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-WARN-B-NEW', 'RETEST-2026-08-18 Warning B child - defined',
     'RETEST-2026-08-18 (P5-CP-029/030). The other 2 points of Feature B.',
     '00000000-0000-7000-8000-00000000f010'::uuid, 'defined', '00000000-0000-7000-8000-00000000f021'::uuid,
     NULL::uuid, '00000000-0000-7000-8000-00000000f041'::uuid, 2::numeric, NULL::timestamptz, 'r1080'),
    -- ── Group C: Velocity and the Ideal baseline ──────────────────────────
    ('00000000-0000-7000-8000-00000000f088'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-MOVE', 'RETEST-2026-08-18 Movable story - no iteration yet',
     'RETEST-2026-08-18 (P6-VEL-004). 3 points, no iteration. Assign it to IT-SEED-COMPLETED: an iteration is assignable by SCOPE, never by lifecycle, and the Velocity bar must follow. It carries Team A because a team-less row is the admin-only Project Backlog.',
     '00000000-0000-7000-8000-00000000f010'::uuid, 'idea', '00000000-0000-7000-8000-00000000f020'::uuid,
     NULL::uuid, NULL::uuid, 3::numeric, NULL::timestamptz, 'r1090'),
    ('00000000-0000-7000-8000-00000000f089'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-ACCEPTED', 'RETEST-2026-08-18 Accepted story - dated inside the window',
     'RETEST-2026-08-18 (P6-VEL-004, P6-IB-003). 5 points accepted 2026-08-17, inside IT-SEED-SNAPSHOT: Velocity classifies it Accepted During.',
     '00000000-0000-7000-8000-00000000f013'::uuid, 'accepted', '00000000-0000-7000-8000-00000000f020'::uuid,
     '00000000-0000-7000-8000-00000000f071'::uuid, NULL::uuid, 5::numeric, '2026-08-17T09:00:00+00'::timestamptz, 'r1100'),
    ('00000000-0000-7000-8000-00000000f08a'::uuid, '00000000-0000-7000-8000-00000000f001'::uuid,
     'US-SEED-REOPENED', 'RETEST-2026-08-18 Reopened story - accepted then reopened',
     'RETEST-2026-08-18 (P6-IB-004). 3 points, in progress with accepted_date NULL: reopening does NOT restore an acceptance. Its audited history is in work.activity_logs below.',
     '00000000-0000-7000-8000-00000000f011'::uuid, 'in_progress', '00000000-0000-7000-8000-00000000f020'::uuid,
     '00000000-0000-7000-8000-00000000f071'::uuid, NULL::uuid, 3::numeric, NULL::timestamptz, 'r1110')
  ) AS v(id, project_id, item_key, title, description, status_id, schedule_state, team_id,
         iteration_id, feature_id, story_points, accepted_date, rank)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 6. CAPACITY PLANS (Group B) — three DRAFT plans, capacity 6 + 5 = 11
-- ============================================================================
-- `status`, `published_at` and `published_by` are RESTORED on a re-run: Publish
-- writes them, Revert/Unpublish is a separate action, and the BA needs the plan
-- back in Draft to walk P5-CP-035 again. Nothing else about a plan is
-- overwritten.
INSERT INTO work.capacity_plans (id, workspace_id, project_id, release_id, plan_key, name, status, unit,
                                 planned_start_date, planned_end_date, published_at, published_by)
VALUES
  ('00000000-0000-7000-8000-00000000f050', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-00000000f030', 'CP-SEED-WARN',
   'RETEST-2026-08-18 CP-SEED-WARN (capacity warnings)', 'draft', 'points',
   '2026-08-01', '2026-08-31', NULL, NULL),
  ('00000000-0000-7000-8000-00000000f051', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-00000000f031', 'CP-SEED-EXACT',
   'RETEST-2026-08-18 CP-SEED-EXACT (window matches its Release)', 'draft', 'points',
   '2026-09-01', '2026-09-30', NULL, NULL),
  ('00000000-0000-7000-8000-00000000f052', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-00000000f032', 'CP-SEED-MISMATCH',
   'RETEST-2026-08-18 CP-SEED-MISMATCH (window does not match its Release)', 'draft', 'points',
   '2026-10-05', '2026-10-25', NULL, NULL)
ON CONFLICT (id) DO UPDATE
  SET status       = EXCLUDED.status,
      published_at = EXCLUDED.published_at,
      published_by = EXCLUDED.published_by;

INSERT INTO work.capacity_plan_teams (id, plan_id, team_id, capacity)
VALUES
  ('00000000-0000-7000-8000-00000000f053', '00000000-0000-7000-8000-00000000f050', '00000000-0000-7000-8000-00000000f020', 6),
  ('00000000-0000-7000-8000-00000000f054', '00000000-0000-7000-8000-00000000f050', '00000000-0000-7000-8000-00000000f021', 5),
  ('00000000-0000-7000-8000-00000000f055', '00000000-0000-7000-8000-00000000f051', '00000000-0000-7000-8000-00000000f020', 6),
  ('00000000-0000-7000-8000-00000000f056', '00000000-0000-7000-8000-00000000f051', '00000000-0000-7000-8000-00000000f021', 5),
  ('00000000-0000-7000-8000-00000000f057', '00000000-0000-7000-8000-00000000f052', '00000000-0000-7000-8000-00000000f020', 6),
  ('00000000-0000-7000-8000-00000000f058', '00000000-0000-7000-8000-00000000f052', '00000000-0000-7000-8000-00000000f021', 5)
ON CONFLICT (id) DO NOTHING;

-- Allocations. `value` is NOT NULL and FIXED (migration 0101): never resolved on
-- read, and `source` is what makes a fixed value honest — `manual` because every
-- number here was chosen, not copied from a Feature forecast.
--
-- `is_primary` is Rally's Planned Team Assignment and is UNIQUE per (plan,
-- item), so exactly one row per split Feature carries it; the CHECK
-- `ck_capacity_primary_has_team` also means a primary row must name a team.
INSERT INTO work.capacity_plan_allocations (id, plan_id, portfolio_item_id, team_id, value, is_primary, source)
VALUES
  -- CP-SEED-WARN: Team A 5 against 6 capacity (children roll up 8 -> Rollup exceeds Estimated);
  --               Team B 7 against 5 capacity (over capacity, 0 complete).
  ('00000000-0000-7000-8000-00000000f060', '00000000-0000-7000-8000-00000000f050',
   '00000000-0000-7000-8000-00000000f040', '00000000-0000-7000-8000-00000000f020', 5, true,  'manual'),
  ('00000000-0000-7000-8000-00000000f061', '00000000-0000-7000-8000-00000000f050',
   '00000000-0000-7000-8000-00000000f041', '00000000-0000-7000-8000-00000000f021', 7, true,  'manual'),
  -- CP-SEED-EXACT: one Feature SPLIT across both teams (3 + 2), primary on Team A.
  ('00000000-0000-7000-8000-00000000f062', '00000000-0000-7000-8000-00000000f051',
   '00000000-0000-7000-8000-00000000f042', '00000000-0000-7000-8000-00000000f020', 3, true,  'manual'),
  ('00000000-0000-7000-8000-00000000f063', '00000000-0000-7000-8000-00000000f051',
   '00000000-0000-7000-8000-00000000f042', '00000000-0000-7000-8000-00000000f021', 2, false, 'manual'),
  -- CP-SEED-MISMATCH: split 4 + 3. A split Feature is N allocation rows and ONE
  -- publish decision (P5-CP-035), so the advisory must appear ONCE.
  ('00000000-0000-7000-8000-00000000f064', '00000000-0000-7000-8000-00000000f052',
   '00000000-0000-7000-8000-00000000f043', '00000000-0000-7000-8000-00000000f020', 4, true,  'manual'),
  ('00000000-0000-7000-8000-00000000f065', '00000000-0000-7000-8000-00000000f052',
   '00000000-0000-7000-8000-00000000f043', '00000000-0000-7000-8000-00000000f021', 3, false, 'manual')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 7. FROZEN BURNDOWN HISTORY + THE IDEAL BASELINE (Group C)
-- ============================================================================
-- FABRICATED history, which production must never write — hence `finalized`
-- true and a hand-run file. The snapshot job only ever writes TODAY and only
-- inside a timebox window, so a past iteration can be given history no other
-- way.
--
-- TWO scopes per day: Team A's own row and the `team_id IS NULL` All Teams row.
-- The All Teams row is MEASURED, never summed from the team rows (a task two
-- teams both touch would count twice), and omitting it would leave an All Teams
-- reader — the DEFAULT scope — with no series at all, which is exactly the bug
-- under retest. Every seeded item here is Team A's, so the two series coincide;
-- that is what measuring each scope independently produces.
--
-- Accepted points tell the same story as the activity log below: 0, then +3 when
-- US-SEED-REOPENED was accepted (08-14), then +5 for US-SEED-ACCEPTED (08-17),
-- then -3 when the reopen took it back out (08-18).
--
-- WHY 08-13/08-14 AND NOT THE BA'S 08-15/08-16. Those two are a Saturday and a
-- Sunday, and `workspace_settings.working_days` is {1,2,3,4,5} — the Burndown's
-- x-axis is WORKING days, so a weekend row is stored and never plotted. Seeding
-- the BA's literal dates would have shown them two points (08-17, 08-18) out of
-- the four their table lists, and the missing one is the acceptance that makes
-- P6-IB-004's point: a snapshot keeps 3 after the item is reopened. The VALUES
-- and the sequence are theirs untouched; only the calendar days move onto
-- weekdays so the series renders. Verified through
-- `GET /reports/iteration-burndown`: four measured days on the axis.
INSERT INTO work.iteration_daily_snapshots (id, workspace_id, iteration_id, team_id, snapshot_date,
                                            remaining_todo, accepted_points, captured_at, finalized)
VALUES
  ('00000000-0000-7000-8000-00000000f090', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', '00000000-0000-7000-8000-00000000f020', '2026-08-13', 20, 0, '2026-08-13T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f091', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', NULL,                                   '2026-08-13', 20, 0, '2026-08-13T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f092', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', '00000000-0000-7000-8000-00000000f020', '2026-08-14', 18, 3, '2026-08-14T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f093', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', NULL,                                   '2026-08-14', 18, 3, '2026-08-14T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f094', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', '00000000-0000-7000-8000-00000000f020', '2026-08-17', 10, 8, '2026-08-17T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f095', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', NULL,                                   '2026-08-17', 10, 8, '2026-08-17T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f096', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', '00000000-0000-7000-8000-00000000f020', '2026-08-18', 13, 5, '2026-08-18T17:00:00+00', true),
  ('00000000-0000-7000-8000-00000000f097', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-00000000f071', NULL,                                   '2026-08-18', 13, 5, '2026-08-18T17:00:00+00', true)
-- The unique index is on the EXPRESSION, not on (iteration_id, team_id, date):
-- `COALESCE(team_id, '00000000-0000-0000-0000-000000000000')` is what makes the
-- All Teams row addressable at all, so ON CONFLICT must name it.
ON CONFLICT (iteration_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date) DO UPDATE
  SET remaining_todo  = EXCLUDED.remaining_todo,
      accepted_points = EXCLUDED.accepted_points,
      captured_at     = EXCLUDED.captured_at,
      finalized       = EXCLUDED.finalized;

-- The Ideal BASELINE, and it is ONE row, for Team A.
--
-- This table's `team_id IS NULL` does NOT mean All Teams — it means "work whose
-- team cannot be resolved" — and every row IS summed for All Teams
-- (`iteration_team_baselines`, migration 0098; CLAUDE.md states the two rules
-- side by side). So writing both a Team A row of 24 AND a NULL row of 24 would
-- draw an All Teams Ideal of 48 above a 24-hour series. Every task in this
-- iteration is Team A's, so one Team A row gives the correct Ideal under BOTH
-- Team A and All Teams. Without any row the chart draws no Ideal line and shows
-- its `noBaseline` note.
INSERT INTO work.iteration_team_baselines (id, workspace_id, iteration_id, team_id,
                                           total_task_estimate_at_start, captured_at)
VALUES
  ('00000000-0000-7000-8000-00000000f098', '00000000-0000-7000-8000-000000000003',
   '00000000-0000-7000-8000-00000000f071', '00000000-0000-7000-8000-00000000f020',
   24, '2026-08-10T08:00:00+00')
ON CONFLICT (iteration_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE
  SET total_task_estimate_at_start = EXCLUDED.total_task_estimate_at_start,
      captured_at                  = EXCLUDED.captured_at;

-- ============================================================================
-- 8. AUDITED HISTORY for US-SEED-REOPENED
-- ============================================================================
-- `work.activity_logs` is the ONLY auditable source for when an item was
-- accepted: `pnpm db:backfill:accepted-date` takes the LATEST
-- 'work_item.schedule_state_changed' row whose `changes->>'new'` is accepted or
-- release, so the shape of `changes` ({field, old, new}, per ActivityChange) and
-- the action name are load-bearing. These two rows are also what the Revision
-- History tab renders.
INSERT INTO work.activity_logs (id, workspace_id, project_id, entity_type, entity_id, actor_id,
                                action, changes, metadata, created_at)
SELECT v.id, '00000000-0000-7000-8000-000000000003'::uuid,
       '00000000-0000-7000-8000-00000000f001'::uuid, 'work_item'::activity_entity_type,
       '00000000-0000-7000-8000-00000000f08a'::uuid,
       (SELECT user_id FROM retest_accounts WHERE role = 'wa'),
       'work_item.schedule_state_changed', v.changes::jsonb,
       '{"source":"RETEST-2026-08-18"}'::jsonb, v.created_at
  FROM (VALUES
    ('00000000-0000-7000-8000-00000000f0a0'::uuid,
     '{"field":"scheduleState","old":"completed","new":"accepted"}',
     '2026-08-14T10:00:00+00'::timestamptz),
    ('00000000-0000-7000-8000-00000000f0a1'::uuid,
     '{"field":"scheduleState","old":"accepted","new":"in_progress"}',
     '2026-08-18T10:00:00+00'::timestamptz)
  ) AS v(id, changes, created_at)
ON CONFLICT (id) DO NOTHING;

COMMIT;

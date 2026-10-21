-- Mirror the bans placed in identity 8 onto the v7 profile table, BEFORE rolling the application back to the v7 image.
--
-- Once identity 8 serves traffic, a person is disabled with `setUserBanned` (identity."user".banned): it ends their sessions, refuses
-- their sign-in and their API tokens. The v7 image knows nothing of that column: it reads `identity.users.status`. Rolling back without
-- this step would quietly reinstate everybody banned since the cutover. This marks them `suspended` in v7's terms, which the v7 sign-in
-- refuses (USER_DEACTIVATED).
--
-- Run it with `node dist/db/identity-v8/cli.js mirror-bans [--commit --database <name>]` (dry run by default: it prints the ids it
-- would change, and rolls back). One transaction, migration role. It writes ONLY identity.users.status (and updated_at), only for a live
-- user who is `active` in v7 and banned in v8 BY v8 (a ban whose reason is 'migrated from v7: ...' is v7's own, copied by the backfill,
-- and mirroring it back is circular), and never the other way round. Idempotent: a second run changes nothing and says so.
--
-- It does NOT undo itself: after a roll-FORWARD to v8 again the backfill re-run keeps those users banned (a ban placed in v8 is v8's),
-- and an unban is `setUserBanned(id, false)` plus `UPDATE identity.users SET status = 'active'` by hand, per person.
WITH changed AS (
  UPDATE identity.users u
  SET status = 'suspended', updated_at = now()
  FROM identity."user" v
  WHERE v.id = u.id
    AND v.banned IS TRUE
    AND (v.ban_reason IS NULL OR v.ban_reason NOT LIKE 'migrated from v7:%')
    AND u.deleted_at IS NULL
    AND u.status = 'active'
  RETURNING u.id
)
SELECT 'v7 user marked suspended: ' || id::text AS what, 1 AS n FROM changed
UNION ALL SELECT 'v7 users changed by this run', count(*)::int FROM changed
UNION ALL SELECT 'v8 users banned (all)', count(*)::int FROM identity."user" WHERE banned IS TRUE;

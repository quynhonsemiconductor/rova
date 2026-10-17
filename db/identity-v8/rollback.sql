-- Roll back migration 0136_identity_v8_tables: drop exactly the four tables it created and forget that it ran.
--
-- Run it with `pnpm db:identity-v8:rollback` (one transaction, migration role). Touches NO v7 object: not
-- identity.users, sso_identities, auth_sessions, sso_connections, api_tokens, nor any other schema.
--
-- REFUSES to drop a table that holds rows, because rows mean the backfill (db/identity-v8/backfill.sql) or a v8
-- sign-in has written to it: dropping them is a decision, not a side effect. v8 data is rebuildable from the v7 tables,
-- which are untouched, so the decision is safe to make; say so explicitly:
--
--     SET rova.allow_drop_identity_v8 = 'yes';   -- in the same session, before this file (the runner has --allow-data-loss)
--
-- It also deletes the migration's row from drizzle.__drizzle_migrations (created_at = the journal's `when`), so that
-- `pnpm db:migrate` applies 0136 again. Without that, drizzle sees a newer migration recorded and skips the file.
DO $$
DECLARE
  rows_held bigint := 0;
  t text;
BEGIN
  IF to_regclass('identity."user"') IS NULL THEN
    RAISE NOTICE 'identity."user" does not exist: nothing to drop';
  END IF;
  FOREACH t IN ARRAY ARRAY['identity."user"', 'identity.session', 'identity.account', 'identity.verification'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', t) INTO rows_held;
      IF rows_held > 0 AND coalesce(current_setting('rova.allow_drop_identity_v8', true), '') <> 'yes' THEN
        RAISE EXCEPTION 'identity v8 rollback refused: % holds % row(s). They are rebuildable from the v7 tables; pass --allow-data-loss (or SET rova.allow_drop_identity_v8 = ''yes'') to drop them.', t, rows_held;
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS identity.account;
DROP TABLE IF EXISTS identity.session;
DROP TABLE IF EXISTS identity.verification;
DROP TABLE IF EXISTS identity."user";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1788344103005;

# Runbook — did every migration run? (journal order)

## What was wrong

`drizzle-orm`'s migrator (`pg-core/dialect.js#migrate`) reads the newest `created_at` in
`drizzle.__drizzle_migrations` **once**, then applies, in one transaction, every journal entry whose `when` is
**greater**. An entry whose `when` is not above its predecessor's is skipped, silently, on any database that had
already applied the predecessor: the `.sql` file is there, `db:migrate` reports success, and the DDL never runs. A
fresh database applies everything in order, and the "Migration upgrade path" job (main's migrations, then the PR's)
never checks that the second batch ran, so nothing noticed.

`db/migrations/meta/_journal.json` had two such entries:

| Entry                       | `when` was                                           | Predecessor's `when`                                            |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `0006_enum_columns`         | 1782052333616 (2026-06-21, drizzle-kit's real clock) | `0005_rls_tenant_isolation` 1782100000000 (hand-written, round) |
| `0019_drop_users_tenant_id` | 1782479593580 (2026-06-26)                           | `0018_users_membership_rls` 1782800000000 (hand-written, round) |

Reproduced on a scratch PostgreSQL with the real files. A database deployed when the journal ended at `0005`, then
upgraded two entries further, applied **7 of 8** migrations with the old journal (`public.work_item_type` missing:
`0006` skipped) and 8 of 8 with the fixed one. Likewise a database at `0018` kept `identity.users.tenant_id` (20 of 21
applied) until `0019` was raised.

## The fix, and what it does to existing databases

`0006` is now 1782100001000 and `0019` 1782800001000: just above their predecessors, still below their successors
(`0007` 1782200000000, `0020` 1782900000000). `db/migrations-journal.spec.ts` now fails the build on any entry that is
not strictly above the one before it, on a gap in `idx`, a missing or unlisted file, a tag number that goes backwards,
or a **new** shared number (`0028` is the one existing pair).

- **A database that already ran them is untouched.** drizzle compares each `when` with the newest `created_at` in the
  database (about 1.788e12 on a current one), so neither new value is "greater" and nothing is re-applied. The two rows
  already in `__drizzle_migrations` keep their old `created_at`. **`db/migrate.ts` does read it back**: its
  post-migrate check (`assertNoStrandedMigrations`) used to match each journal entry to a row by `created_at = when`, so
  on every existing database `0006` and `0019` looked stranded and the run printed "NO recorded row ... recreate the
  database", which is the wrong advice for a database that is fine. It now falls back to the file's **hash** when nothing
  sits at the entry's `when` (`db/stranded-migrations.ts`, with an existing-database fixture), and says at info
  "ran under an earlier timestamp ... found by their file's hash". Only an entry found neither way is reported.
- **A database stuck behind either one now applies it** on the next `db:migrate`.
- **A database at HEAD that nevertheless skipped one is NOT repaired by the edit** (its newest `created_at` is above the
  new value). That is what the checks below are for.

## Could a deployed database have skipped them? Very unlikely

Both entries arrived with `0000`-`0019` in the monorepo's first commit (`85da7c23`, 2026-07-01), so a database created
from this repository ran the whole journal from empty, in order. Only a database created by the pre-monorepo `rally-api`
and then upgraded could have skipped one. And later migrations would have failed without them:

- `0006` is the only migration that creates `public.work_item_type`, `sprint_status`, `release_status`, `team_status` and
  the other enums. `0036` does `ADD COLUMN "item_type" "public"."work_item_type"`, `0021` renames `sprint_status`, `0029`
  does `ALTER TYPE public.release_status RENAME`. Each fails on a database without them.
- `0019` is the only migration that drops `identity.users.tenant_id`, created `NOT NULL` with no default in `0000`. The
  current schema inserts users without it, so on a database that skipped `0019` those inserts would fail.

So no repair migration is added. The SQL below confirms it in each environment; I could not run it (no database access
from the review environment).

## Confirm (read-only) - develop and production

Run through the SSM tunnel with a read-only role: develop on local port 15432 (`qnsc-developer`), production on 25432
(`qnsc-prod-breakglass`, incident diagnosis only; use a least-privilege role's credentials, never the RDS master).
Nothing here writes.

```sql
-- 1. Both migrations are recorded. Expect 2 rows. created_at is the OLD `when` for a database that ran them before this
--    change (1782052333616 and 1782479593580), or the new one (1782100001000, 1782800001000) for a database built after.
SELECT id, hash, created_at
  FROM drizzle.__drizzle_migrations
 WHERE hash IN (
   'f55b4a89b2dd350dfc96dd03c45786f88de54b2ce63f6e16b26888cc1d6d5be3',  -- 0006_enum_columns
   '64f2c301e89b103014530f5c6e0c60fba5c30a6ee802d729aa03e6a8a668c828'   -- 0019_drop_users_tenant_id
 )
 ORDER BY created_at;

-- 2. Their effects exist, whatever the table says. Both must be true.
SELECT to_regtype('public.work_item_type') IS NOT NULL                       AS ran_0006,
       NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'identity' AND table_name = 'users'
                      AND column_name = 'tenant_id')                          AS ran_0019;

-- 3. Nothing else is missing: one row per journal entry. 136 on main today (0000..0134, 0028 twice); 137 once the
--    lease-and-fence relay migration (0135) ships. A smaller number means a migration was skipped; compare hashes
--    with `shasum -a 256 db/migrations/<tag>.sql` (drizzle's hash is the sha256 of the file's text).
SELECT count(*) AS applied, max(created_at) AS newest FROM drizzle.__drizzle_migrations;
```

The hashes are the `sha256` of the migration files exactly as drizzle computes them
(`crypto.createHash('sha256').update(fileText)`). Neighbours, for cross-checking:
`0005_rls_tenant_isolation` `dcd4f95bc90610436dceb123795be5dd7952bddc868d3ebbfc180e2b502ad8be`,
`0018_users_membership_rls` `6a5aa3099241fa6abb0916ccb932a7e35929d47b6e200f6f0c6159a52b46fd20`.

## If a check fails

Stop and tell the owner; do not edit `__drizzle_migrations`. The repair for a database at HEAD that skipped `0006` or
`0019` is to run that one file by hand, in a transaction, and record it in the same transaction (develop first):

```sql
BEGIN;
\i db/migrations/0006_enum_columns.sql      -- or 0019_drop_users_tenant_id.sql
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('<the hash above>', <the new `when` from _journal.json>);
COMMIT;
```

(`psql` runs the file's statements as written; `--> statement-breakpoint` is a comment to it.)

# identity v8: the data model, and how the data gets there

rova moves from `@quynhonsemiconductor/identity` 7.x to 8.x (the identity v8 plan §8.5). This page is the data half of that move. It describes
what exists **now** (the tables, shipped ahead of the code), what runs **at the cutover** (the backfill), and how to undo either.

Nothing here changes what rova does today: no code reads or writes the v8 tables yet.

## What is in the database now

Migration `0136_identity_v8_tables` adds four tables to the `identity` schema, next to the v7 ones, and two house indexes beyond `auth generate`'s output: `account (provider_id, account_id)` (Better Auth looks an account up by it on every Microsoft sign-in) and a partial `session (context_id)` for `clearContext*`. No v7 table is touched.

| Table                   | What it is                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `identity."user"`       | Better Auth's login identity (**singular**; v8)                                               |
| `identity.session`      | v8 sessions, with `context_id` (identity 8.4: the active workspace)                           |
| `identity.account`      | the Microsoft identity of a user: `provider_id = 'microsoft'`, `account_id` = the Entra `oid` |
| `identity.verification` | Better Auth's short-lived tokens (OAuth state)                                                |

No `organization`, `member`, `sso_provider`, `invitation` or `two_factor` table: rova runs the `staff` preset (with `staff.allowGuests`) and
defers per-workspace SSO. The tables are generated for exactly that `createIdentity` call (`db/schema/identity-auth.ts`).

## `identity.users` stays

rova's own `identity.users` (**plural**) is the product's **profile** table: `status`, `locale`, `timezone`, `phone`, `last_login_at`,
`deleted_at`, and the id every `user_id` column in the schema points at. It is kept. The two tables are linked **by value**:

```
identity.users.id  =  identity."user".id        one-to-one, same uuid, no foreign key
```

No FK, on purpose: a soft-deleted or never-signed-in profile row has no login identity, and an FK either way would force one to exist for
the other. The invariant is **asserted** by the backfill (set differences both ways) and by `test/e2e/identity-v8-tables.e2e.spec.ts`; at
the cutover a monitor query will watch it:

```sql
-- both must be empty
SELECT id FROM identity.users WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM identity."user");
SELECT u.id FROM identity."user" u WHERE u.id NOT IN (SELECT id FROM identity.users WHERE deleted_at IS NULL)
AND NOT (u.banned AND u.id IN (SELECT id FROM identity.users WHERE deleted_at IS NOT NULL));  -- banned by v7 soft-delete: exempt
```

## How the v7 rows become v8 rows (the backfill)

`db/identity-v8/backfill.sql`, run by `pnpm db:identity-v8:backfill`. **It is not a migration**: it is not in the drizzle journal, `pnpm db:migrate`
never runs it, and it has not been run anywhere. It is rehearsed in CI on a seeded copy with guests and vendors.

| v7                                               | v8                                                           | Rule                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.users` where `deleted_at IS NULL`      | `identity."user"`                                            | same `id`; `lower(email)`; `display_name` → `name`; `avatar_url` → `image`                                                                                                                                                                |
| `status` `inactive` / `suspended`                | `banned = true`, `ban_reason = 'migrated from v7: <status>'` | `active` and `invited` are not banned                                                                                                                                                                                                     |
| `email_verified`                                 | `email_verified`                                             | the v7 value **OR** the user has an Entra identity **OR** the address is on a staff domain (the tenant vouches). For rova that is `true` for every row that gets through the preflight                                                    |
| `identity.sso_identities` (`provider = 'entra'`) | `identity.account`                                           | `provider_id = 'microsoft'`, `account_id = provider_sub` (the Entra `oid`). **Vendors and guests included**: a guest whose address already has a v8 user is refused (`ACCOUNT_LINK_REQUIRED`) unless that user already holds the same oid |
| `identity.auth_sessions`, `refresh_tokens`       | —                                                            | **not migrated**: everyone signs in once                                                                                                                                                                                                  |
| soft-deleted users                               | —                                                            | not copied; they stay as profile rows so history keeps its names                                                                                                                                                                          |
| `workspace.workspace_members`                    | `session.context_id`                                         | set at sign-in by identity's `context.initial` (the last-active workspace)                                                                                                                                                                |
| `identity.api_tokens`, `workspace_*`             | unchanged                                                    | rova keeps its API-token module                                                                                                                                                                                                           |

Why not just `email_verified = true` for everyone: see the header of `backfill.sql` and `MIGRATION-v7-to-v8.md`.

### It refuses, before writing anything, what it cannot map

Every message names ids and counts, never an address. The whole script is one transaction.

| Preflight                                                                                                                  | Meaning                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| two live users share an address once lower-cased                                                                           | v8 needs one unique lower-cased address                                                                  |
| an identity of a provider other than `entra`                                                                               | v8 has no equivalent                                                                                     |
| a user with two Entra identities                                                                                           | v8 holds one Microsoft identity per user                                                                 |
| a user with **no** Entra identity and an address outside the staff domains                                                 | a pre-invited outsider: a v8 user without the account would be refused on first sign-in. Decide per user |
| an `sso_connections` row that is neither the home directory connection (your `--tenant-id`) nor a `shared` guest gate      | partner / per-workspace SSO is not part of this migration; the row would be left behind                  |
| an owner of a live v7 session with no Entra identity                                                                       | a dev-login session, or data that should not be in a deployed environment                                |
| an existing v8 user that disagrees with v7 (same id other address, or same address other id), or an oid on another v8 user | a re-run or a v8 sign-in found something inconsistent                                                    |

After the inserts it **asserts** (each a `RAISE`): every live v7 user has a v8 user with the same id and address, and every v8 user is a live profile;
every Entra identity of a live user is a Microsoft account of that user with the same oid; a user with an Entra identity has **exactly one**
Microsoft account and nobody has more than one; every owner of a live v7 session has exactly one v8 user and one account; the `banned` flag matches the
status; nobody migrated is unverified.

### Running it

```bash
# dry run: does all of it, checks all of it, ROLLS BACK
pnpm db:identity-v8:backfill --tenant-id "$ENTRA_TENANT_ID" --staff-domains qnsc.vn
# for real
pnpm db:identity-v8:backfill --tenant-id "$ENTRA_TENANT_ID" --staff-domains qnsc.vn --commit
```

It uses the migration role (`DATABASE_MIGRATION_URL`). `--commit` also needs `--database <name>` equal to the database the connection is on: a write to the wrong database is the one mistake a dry run cannot catch. One transaction, `REPEATABLE READ`.

It is **idempotent and re-runnable**: re-run it at the cutover to pick up what v7 did since the last run. A re-run INSERTs new users, UPDATEs the name and avatar of existing ones to match v7, bans anyone v7 has inactive or suspended, and bans (never deletes) a v8 user whose profile was soft-deleted since. It never touches `email_verified` of a user that already exists in v8. It writes no session: revoke a banned user's sessions through the product.

**A ban placed in v8 is never lifted by a re-run; a ban the backfill itself placed follows v7.** Once identity 8 serves traffic a person is disabled in v8 (`setUserBanned`). A re-run keeps every ban that is already there and is **not** the backfill's own (no reason, or a reason other than `migrated from v7: ...`), with its reason. A ban whose reason is `migrated from v7: <status>` is v7's, copied by an earlier run: it follows v7, so someone un-suspended in v7 since is un-banned by the next run (and `mirror-bans`, which mirrors only v8's bans, does not re-suspend them). The assertion is "everyone v7 has inactive or suspended is banned in v8", not the reverse.

**A re-run after the cutover is supported.** A B2B guest who signed in on v8 has a Microsoft account and no v7 identity (and an unverified address): the preflight and the assertions ignore them instead of refusing.

**Before a rollback to the v7 image**, mirror the bans onto v7's terms: `node dist/db/identity-v8/cli.js mirror-bans` (a dry run that prints the ids it would change) then `... mirror-bans --commit --database <name>`. The v7 image reads `identity.users.status`, not identity 8's `banned`; without this the rollback quietly reinstates everybody banned since the cutover. It writes only `status = 'suspended'` (and `updated_at`), only for a live user who is `active` in v7 and banned **by v8** (not a `migrated from v7` ban), prints each id it changed and the count of changes (a second run says `0`).

**Where it runs from.** The migrator image carries `db/identity-v8/*.sql` next to the compiled runner (since #719): `node dist/db/identity-v8/cli.js backfill ...`. On a production environment the image only comes from a release tag, so there the cutover tag's own migrator commits the backfill (`IDENTITY_V8_BACKFILL=commit`, after the migrations and before the API rolls, failing the deploy on any raise); dry runs ahead of it use an explicit image digest. docs/runbooks/identity-v8-cutover.md, "Production".

## Undoing it

| To undo        | Do                                                                                      | Effect                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| the backfill   | `TRUNCATE`-free: delete the v8 rows, or run the rollback below with `--allow-data-loss` | the v7 tables are untouched, so nothing is lost; the v8 rows are rebuildable                                                                         |
| migration 0136 | `pnpm db:identity-v8:rollback`                                                          | drops exactly the four tables and forgets the migration, so `pnpm db:migrate` applies it again. Refuses if they hold rows unless `--allow-data-loss` |

The rollback touches no v7 object. CI proves it: up, down, up on an empty database; and 0136 applied to a database that already has rova's schema
and v7 data changes none of it (every other table's columns, indexes, constraints, triggers and rows hash the same before and after).

## What is NOT done yet

The code (identity 8, `SessionGuard`, the web client), the backfill run, the Entra redirect URI, `BETTER_AUTH_SECRET`, and the day-7 freeze / day-30 drop
of the v7 tables. Those are PR 3 and the cutover.

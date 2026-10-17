-- identity v8 BACKFILL: the data that moves from rova's v7 identity tables into the v8 ones.
--
-- NOT A MIGRATION. It is not in the drizzle journal, `pnpm db:migrate` never runs it, and nothing runs it until the
-- cutover (PR 3 of the identity v8 plan). It lives next to the schema (migration 0136) so it is reviewed, tested and
-- rehearsed on a seeded copy long before anyone depends on it. Run it with
--
--     pnpm db:identity-v8:backfill --tenant-id <ENTRA_TENANT_ID> --staff-domains qnsc.vn            # DRY RUN: does all of it, then ROLLS BACK
--     pnpm db:identity-v8:backfill --tenant-id <ENTRA_TENANT_ID> --staff-domains qnsc.vn --commit
--
-- ONE TRANSACTION (REPEATABLE READ): preflight (RAISES), inserts, assertions (RAISE). Any failure rolls everything back.
-- IDEMPOTENT: the inserts skip what is already there and UPDATE what v7 changed (name, avatar, ban), a user deleted in v7 since
-- is banned in v8, so it can be re-run at cutover to pick up users that v7 created or changed since the last run. It reads v7 and writes only identity."user" and identity.account; no v7 row is changed.
--
-- THE MAPPING (docs/runbooks/identity-v8-data-model.md):
--   identity.users (deleted_at IS NULL)        -> identity."user"   same id; lower(email); display_name -> name; avatar_url -> image;
--                                                  email_verified = v7 value OR Entra identity OR staff domain (see below); status inactive|suspended -> banned (reason 'migrated from v7: <status>')
--   identity.sso_identities (provider 'entra') -> identity.account  provider_id 'microsoft'; account_id = provider_sub (the Entra oid)
--   identity.auth_sessions                     -> NOT migrated. Everyone signs in once.
--   soft-deleted users                         -> not copied. They stay as profile rows (history keeps its names).
--
-- WHY email_verified IS NOT COPIED FROM v7, AND IS NOT BLANKET-TRUE EITHER. It is: the v7 value, OR the user has an Entra
-- identity, OR the address is on a staff domain (the tenant vouches for the address). When a Microsoft member signs in, identity
-- DELETES an existing user for that address that is unverified, holds no non-credential account and has no session row, and signs
-- the person in as a NEW user with a NEW id (the squatting rule, identity plan D10). A migrated user starts with no v8 session, so
-- an unverified one with no account would be replaced on first sign-in and every foreign key to its id would dangle. Blanket-true
-- would be wrong in a product with password sign-in (an attacker pre-registers victim@x; copied as verified, the victim's first
-- Microsoft sign-in links into the attacker's account). rova has no passwords, and the preflight below refuses any user who is neither
-- an Entra user nor a staff address, so the rule is TRUE for every row that reaches the insert; it is written as the rule so that
-- the file stays correct if a row ever gets past the preflight. (MIGRATION-v7-to-v8.md, reviewed in app-platform#257.)
--
-- WHY EVERY ENTRA IDENTITY BECOMES AN ACCOUNT, GUESTS INCLUDED (staff.allowGuests). A B2B guest whose address already
-- belongs to a v8 user is REFUSED (ACCOUNT_LINK_REQUIRED) unless that user already holds the same (microsoft, oid)
-- account: a guest never auto-links. So a vendor who has signed in before keeps signing in only because of the row below.
-- A guest is a user with an Entra identity whose address is off the staff domains; the preflight therefore also rejects a
-- user with NO Entra identity and an address off the staff domains (a pre-invited outsider: with a v8 user and no
-- account, their first sign-in would be refused; with no v8 user it creates one).
--
-- THE DOMAIN OF AN ADDRESS is the part after the LAST '@' (substring ... from '@([^@]+)$'). split_part(email, '@', 2) would read
-- 'a@qnsc.vn@evil.example' as a staff address. The staff domains arrive lower-cased and exact (the runner lower-cases them).
--
-- INPUTS, set by the runner as transaction-local settings:
--   rova.v8_tenant_id      the home Entra tenant (ENTRA_TENANT_ID): the one `directory` connection allowed
--   rova.v8_staff_domains  comma-separated staff email domains (qnsc.vn), each matched exactly
--
-- Every message names ids and counts, never an address.

-- ── 1. Preflight: everything this script cannot map, found BEFORE anything is written ──────────────────────────
DO $$
DECLARE
  tenant  text   := nullif(current_setting('rova.v8_tenant_id', true), '');
  domains text[] := string_to_array(lower(coalesce(nullif(current_setting('rova.v8_staff_domains', true), ''), '')), ',');
  n       bigint;
  ids     text;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'identity v8 backfill: rova.v8_tenant_id is not set (pass --tenant-id <ENTRA_TENANT_ID>)';
  END IF;
  IF cardinality(domains) = 0 OR domains = ARRAY[''] THEN
    RAISE EXCEPTION 'identity v8 backfill: rova.v8_staff_domains is not set (pass --staff-domains qnsc.vn)';
  END IF;
  IF to_regclass('identity."user"') IS NULL OR to_regclass('identity.account') IS NULL THEN
    RAISE EXCEPTION 'identity v8 backfill: the v8 tables do not exist (migration 0136_identity_v8_tables has not run)';
  END IF;

  -- v8 requires one unique lower-cased address per user.
  SELECT count(*), string_agg(ids_per::text, ' ') INTO n, ids FROM (
    SELECT array_agg(id ORDER BY id) AS ids_per FROM identity.users WHERE deleted_at IS NULL
    GROUP BY lower(email) HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % address(es) are shared by more than one live user once lower-cased (user ids: %). Merge or delete the duplicates first.', n, ids;
  END IF;

  -- Providers with no v8 equivalent.
  SELECT count(*), string_agg(s.user_id::text, ' ') INTO n, ids
  FROM identity.sso_identities s JOIN identity.users u ON u.id = s.user_id AND u.deleted_at IS NULL
  WHERE s.provider <> 'entra';
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % identity row(s) belong to a provider other than entra, which v8 cannot map (user ids: %)', n, ids;
  END IF;

  -- v8 holds one Microsoft identity per user.
  SELECT count(*), string_agg(user_id::text, ' ') INTO n, ids FROM (
    SELECT s.user_id FROM identity.sso_identities s JOIN identity.users u ON u.id = s.user_id AND u.deleted_at IS NULL
    WHERE s.provider = 'entra' GROUP BY s.user_id HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % user(s) hold more than one Entra identity (user ids: %)', n, ids;
  END IF;

  -- A user with NO Entra identity must be a staff-domain address (they link on first sign-in). Anyone else is an
  -- outsider who was pre-invited: do not copy them (see the header).
  SELECT count(*), string_agg(u.id::text, ' ') INTO n, ids
  FROM identity.users u
  WHERE u.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM identity.sso_identities s WHERE s.user_id = u.id AND s.provider = 'entra')
    AND substring(lower(u.email) from '@([^@]+)$') <> ALL (domains);
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % live user(s) have no Entra identity and an address outside the staff domains (user ids: %). A v8 user without the account would be refused on first sign-in; decide per user (remove them, or let their first sign-in create them).', n, ids;
  END IF;

  -- Partner SSO is deferred by decision: only the home directory connection and the `shared` guest gate may exist.
  SELECT count(*), string_agg(id::text, ' ') INTO n, ids FROM identity.sso_connections
  WHERE NOT ((kind = 'directory' AND external_tenant_id = tenant) OR kind = 'shared');
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % sso_connections row(s) are neither the home directory connection (tenant %) nor a shared guest gate (connection ids: %). Per-workspace SSO is not part of this migration; they would be left behind.', n, tenant, ids;
  END IF;

  -- A v7 session owner must be an SSO user: nothing else can sign in v8.
  SELECT count(*), string_agg(o.user_id::text, ' ') INTO n, ids FROM (
    SELECT DISTINCT a.user_id FROM identity.auth_sessions a
    JOIN identity.users u ON u.id = a.user_id AND u.deleted_at IS NULL     -- a soft-deleted user's old session is nobody's problem
    WHERE NOT a.is_revoked AND a.expires_at > now()) o
  WHERE NOT EXISTS (SELECT 1 FROM identity.sso_identities s WHERE s.user_id = o.user_id AND s.provider = 'entra');
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % owner(s) of a live v7 session have no Entra identity (user ids: %): a dev-login session, or data that should not exist in a deployed environment', n, ids;
  END IF;

  -- v8 rows that already exist must AGREE with v7 (a re-run, or a sign-in under v8): same address same id, same oid same user.
  SELECT count(*), string_agg(id::text, ' ') INTO n, ids FROM (
    SELECT u.id FROM identity.users u JOIN identity."user" v ON v.id = u.id AND v.email <> lower(u.email)
    WHERE u.deleted_at IS NULL
    UNION
    SELECT u.id FROM identity.users u JOIN identity."user" v ON v.email = lower(u.email) AND v.id <> u.id
    WHERE u.deleted_at IS NULL) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % v7 user(s) clash with an existing v8 user: the same id with another address, or the same address with another id (v7 user ids: %)', n, ids;
  END IF;

  SELECT count(*), string_agg(s.user_id::text, ' ') INTO n, ids
  FROM identity.sso_identities s JOIN identity.account a ON a.provider_id = 'microsoft' AND a.account_id = s.provider_sub
  WHERE s.provider = 'entra' AND a.user_id <> s.user_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'identity v8 backfill: % Entra identity(ies) are already attached to a DIFFERENT v8 user (v7 user ids: %)', n, ids;
  END IF;
END $$;

-- ── 2. The users ───────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO identity."user" (id, name, email, email_verified, image, banned, ban_reason, created_at, updated_at)
SELECT u.id,
       u.display_name,
       lower(u.email),
       (u.email_verified
         OR EXISTS (SELECT 1 FROM identity.sso_identities s WHERE s.user_id = u.id AND s.provider = 'entra')
         OR substring(lower(u.email) from '@([^@]+)$') = ANY (string_to_array(lower(current_setting('rova.v8_staff_domains')), ','))),
       u.avatar_url,
       u.status IN ('inactive', 'suspended'),
       CASE WHEN u.status IN ('inactive', 'suspended') THEN 'migrated from v7: ' || u.status::text END,
       u.created_at,
       now()
FROM identity.users u
WHERE u.deleted_at IS NULL
-- A re-run carries what v7 changed since the last run: a rename, a new avatar, a suspension. Guarded on the address matching
-- (a clash was refused above), and a no-op when nothing differs. email_verified is NOT touched: once a user exists in v8 it is
-- identity's.
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      image = EXCLUDED.image,
      banned = EXCLUDED.banned,
      ban_reason = EXCLUDED.ban_reason,
      updated_at = now()
  WHERE identity."user".email = EXCLUDED.email
    AND (identity."user".name, identity."user".image, identity."user".banned, identity."user".ban_reason)
        IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.image, EXCLUDED.banned, EXCLUDED.ban_reason);

-- A user soft-deleted in v7 since the last run keeps its v8 row (it may hold accounts and sessions) but can no longer sign in.
-- Revoke its sessions through the product (revokeUserSessions): this script writes no session.
UPDATE identity."user" v
SET banned = TRUE, ban_reason = 'migrated from v7: deleted', updated_at = now()
FROM identity.users u
WHERE u.id = v.id AND u.deleted_at IS NOT NULL
  AND (v.banned IS NOT TRUE OR v.ban_reason IS DISTINCT FROM 'migrated from v7: deleted');

-- ── 3. The Microsoft account of every Entra identity (guests and vendors included) ─────────────────────────────
INSERT INTO identity.account (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT gen_random_uuid(), s.provider_sub, 'microsoft', s.user_id, s.created_at, now()
FROM identity.sso_identities s
JOIN identity."user" v ON v.id = s.user_id          -- an identity of an excluded (soft-deleted) user has no v8 user
WHERE s.provider = 'entra'
  AND NOT EXISTS (SELECT 1 FROM identity.account a WHERE a.user_id = s.user_id AND a.provider_id = 'microsoft');

-- ── 4. Assertions: set differences, both ways where both ways are meaningful; each RAISES ──────────────────────
DO $$
DECLARE
  n bigint;
BEGIN
  -- Every live v7 user has a v8 user with the SAME id and address ...
  SELECT count(*) INTO n FROM (
    SELECT id, lower(email) FROM identity.users WHERE deleted_at IS NULL
    EXCEPT
    SELECT id, email FROM identity."user") d;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % live v7 user(s) have no v8 user with the same id and address', n; END IF;

  -- ... and every v8 user is a live profile, or the profile of a user deleted in v7 since (then banned): a v8 user the profile
  -- table does not know would be a login with no person.
  SELECT count(*) INTO n FROM identity."user" v
  WHERE NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = v.id AND u.deleted_at IS NULL)
    AND NOT (EXISTS (SELECT 1 FROM identity.users d WHERE d.id = v.id AND d.deleted_at IS NOT NULL) AND v.banned IS TRUE);
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % v8 user(s) are not a live profile in identity.users (and not a banned, soft-deleted one)', n; END IF;

  -- Every Entra identity of a live user is a Microsoft account of that user, with the same oid.
  SELECT count(*) INTO n FROM (
    SELECT s.user_id, s.provider_sub FROM identity.sso_identities s
    JOIN identity.users u ON u.id = s.user_id AND u.deleted_at IS NULL WHERE s.provider = 'entra'
    EXCEPT
    SELECT user_id, account_id FROM identity.account WHERE provider_id = 'microsoft') d;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % Entra identity(ies) have no matching v8 account', n; END IF;

  -- EXACTLY ONE Microsoft account per user that has an Entra identity, and never more than one for anyone.
  SELECT count(*) INTO n FROM identity.users u
  WHERE u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM identity.sso_identities s WHERE s.user_id = u.id AND s.provider = 'entra')
    AND (SELECT count(*) FROM identity.account a WHERE a.user_id = u.id AND a.provider_id = 'microsoft') <> 1;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % user(s) with an Entra identity do not have exactly one Microsoft account', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT user_id FROM identity.account WHERE provider_id = 'microsoft' GROUP BY user_id HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % v8 user(s) hold more than one Microsoft account', n; END IF;

  -- Every owner of a live v7 session: exactly one v8 user and exactly one Microsoft account.
  SELECT count(*) INTO n FROM (
    SELECT DISTINCT a.user_id FROM identity.auth_sessions a
    JOIN identity.users u ON u.id = a.user_id AND u.deleted_at IS NULL
    WHERE NOT a.is_revoked AND a.expires_at > now()) o
  WHERE (SELECT count(*) FROM identity."user" v WHERE v.id = o.user_id) <> 1
     OR (SELECT count(*) FROM identity.account a WHERE a.user_id = o.user_id AND a.provider_id = 'microsoft') <> 1;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % owner(s) of a live v7 session do not have exactly one v8 user and one Microsoft account', n; END IF;

  -- The ban mapping, both columns, for every migrated user.
  SELECT count(*) INTO n FROM (
    SELECT id, (status IN ('inactive', 'suspended')) FROM identity.users WHERE deleted_at IS NULL
    EXCEPT
    SELECT id, coalesce(banned, FALSE) FROM identity."user") d;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % user(s) have the wrong banned flag', n; END IF;

  -- Nobody migrated is unverified (the squatting rule would replace them on first sign-in).
  SELECT count(*) INTO n FROM identity."user" v
  JOIN identity.users u ON u.id = v.id AND u.deleted_at IS NULL
  WHERE NOT v.email_verified;
  IF n > 0 THEN RAISE EXCEPTION 'identity v8 backfill assertion failed: % migrated user(s) are not email_verified', n; END IF;

  -- The counts agree (a belt for the set differences above).
  IF (SELECT count(*) FROM identity."user") < (SELECT count(*) FROM identity.users WHERE deleted_at IS NULL) THEN
    RAISE EXCEPTION 'identity v8 backfill assertion failed: fewer v8 users than live v7 users';
  END IF;
END $$;

-- ── 5. The summary the runner prints ───────────────────────────────────────────────────────────────────────────
SELECT 'v7 live users' AS what, count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL
UNION ALL SELECT 'v7 soft-deleted users (not copied)', count(*)::int FROM identity.users WHERE deleted_at IS NOT NULL
UNION ALL SELECT 'v7 entra identities of live users', count(*)::int FROM identity.sso_identities s JOIN identity.users u ON u.id = s.user_id AND u.deleted_at IS NULL WHERE s.provider = 'entra'
UNION ALL SELECT 'v8 users', count(*)::int FROM identity."user"
UNION ALL SELECT 'v8 users banned', count(*)::int FROM identity."user" WHERE banned
UNION ALL SELECT 'v8 microsoft accounts', count(*)::int FROM identity.account WHERE provider_id = 'microsoft'
UNION ALL SELECT 'v8 users without an account (staff domain, link on first sign-in)', count(*)::int FROM identity."user" v WHERE NOT EXISTS (SELECT 1 FROM identity.account a WHERE a.user_id = v.id)
UNION ALL SELECT 'v8 sessions', count(*)::int FROM identity.session;

/**
 * identity v8, step 2: the schema (migration 0136) and the prepared, NOT-yet-run backfill.
 *
 * Every database here is a THROWAWAY: created from the connection's cluster, migrated, and dropped. The shared e2e
 * database is never touched, so the suite's own fixtures cannot interfere and this spec cannot disturb them.
 *
 * What it proves:
 *   1. up / down / up on an empty database: the four v8 tables appear, are removed by the rollback (and only they), and
 *      appear again; the rollback also forgets the migration so `db:migrate` re-applies it; and it refuses to drop rows.
 *   2. a database that ALREADY HAS rova's schema and v7 data: applying 0136 changes nothing of it (every other table,
 *      column, index, constraint, trigger and row hashes the same before and after).
 *   3. the backfill, against a seeded copy WITH guests and vendors: the mapping, idempotency, the dry run that writes
 *      nothing, every preflight refusal (and that a refusal writes nothing), and every assertion (by corrupting the
 *      result and watching it fail loudly).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBackfillIfRequested } from '../../db/identity-v8/on-deploy';
import {
  runBackfill,
  runMirrorBans,
  runRollback,
  type BackfillOptions,
} from '../../db/identity-v8/run';

const MIGRATIONS = join(__dirname, '../../db/migrations');
const V8_SQL_DIR = join(__dirname, '../../db/identity-v8');
const V8_TABLES = [
  'identity.user',
  'identity.session',
  'identity.account',
  'identity.verification',
];
const TAG = '0136_identity_v8_tables';
const TENANT = 'tenant-home';
const OPTS: BackfillOptions = { tenantId: TENANT, staffDomains: ['qnsc.vn'], commit: true };

const baseUrl = process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
if (!baseUrl)
  throw new Error(
    'identity v8 e2e needs DATABASE_MIGRATION_URL (or DATABASE_URL): a role that can CREATE DATABASE',
  );

const urlFor = (name: string): string => {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

// ── throwaway databases ───────────────────────────────────────────────────────────────────────────────────────────
const created: string[] = [];
let admin: Client;

async function createDatabase(template?: string): Promise<string> {
  const name = `rova_v8_${randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ''}`);
  created.push(name);
  return name;
}
async function dropDatabase(name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** The migrations folder, optionally cut after `tag` (drizzle applies what the JOURNAL lists, not what is on disk). */
function migrationsUpTo(tag?: string): { folder: string; cleanup(): void } {
  if (!tag) return { folder: MIGRATIONS, cleanup: () => undefined };
  const folder = mkdtempSync(join(tmpdir(), 'rova-migrations-'));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`no migration ${tag}`);
  journal.entries = journal.entries.slice(0, at + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

async function migrateDatabase(name: string, upTo?: string): Promise<void> {
  const pool = new Pool({ connectionString: urlFor(name), max: 1 });
  const { folder, cleanup } = migrationsUpTo(upTo);
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
    cleanup();
  }
}

async function withPool<T>(name: string, fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: urlFor(name), max: 2 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Run `fn` on a dedicated connection to a database. */
async function withClient<T>(name: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ── a fingerprint of everything that is NOT one of the v8 tables ─────────────────────────────────────────────────
async function fingerprint(
  pool: Pool,
  ignore: readonly string[] = V8_TABLES,
): Promise<Record<string, string>> {
  const skip = new Set(ignore);
  const tables = (
    await pool.query<{ s: string; t: string }>(
      `select table_schema s, table_name t from information_schema.tables
       where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema', 'drizzle')
       order by 1, 2`,
    )
  ).rows;
  const out: Record<string, string> = {};
  for (const { s, t } of tables) {
    if (skip.has(`${s}.${t}`)) continue;
    const q = (text: string): Promise<unknown[]> =>
      pool.query(text, [s, t]).then((r) => r.rows as unknown[]);
    const shape = {
      columns: await q(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
         where table_schema = $1 and table_name = $2 order by ordinal_position`,
      ),
      indexes: await q(
        `select indexdef from pg_indexes where schemaname = $1 and tablename = $2 order by indexname`,
      ),
      constraints: await q(
        `select conname, pg_get_constraintdef(oid) d from pg_constraint
         where conrelid = format('%I.%I', $1::text, $2::text)::regclass order by conname`,
      ),
      triggers: await q(
        `select tgname from pg_trigger where tgrelid = format('%I.%I', $1::text, $2::text)::regclass and not tgisinternal order by tgname`,
      ),
      data: (
        await pool.query(
          `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h, count(*)::int n from "${s}"."${t}" x`,
        )
      ).rows[0],
    };
    out[`${s}.${t}`] = createHash('md5').update(JSON.stringify(shape)).digest('hex');
  }
  return out;
}

const v8TablesPresent = async (pool: Pool): Promise<string[]> =>
  (
    await pool.query<{ n: string }>(
      `select table_schema || '.' || table_name n from information_schema.tables
       where table_schema = 'identity' and table_name in ('user', 'session', 'account', 'verification') order by 1`,
    )
  ).rows.map((r) => r.n);

const migrationRecorded = async (pool: Pool, when: number): Promise<boolean> =>
  (await pool.query(`select 1 from drizzle.__drizzle_migrations where created_at = $1`, [when]))
    .rowCount === 1;

const journalWhen = (tag: string): number => {
  const j = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const entry = j.entries.find((e) => e.tag === tag);
  if (!entry) throw new Error(`no journal entry ${tag}`);
  return entry.when;
};

// ── v7 data: the shapes rova really has, guests and vendors included ─────────────────────────────────────────────
const U = {
  alice: '00000000-0000-7000-8000-0000000000a1', // staff, active, live session
  bob: '00000000-0000-7000-8000-0000000000a2', // staff, suspended
  carol: '00000000-0000-7000-8000-0000000000a3', // staff, inactive, expired session
  dan: '00000000-0000-7000-8000-0000000000a4', // staff, SOFT-DELETED
  erin: '00000000-0000-7000-8000-0000000000a5', // staff domain, status 'invited', NO identity yet
  frank: '00000000-0000-7000-8000-0000000000a6', // staff, mixed-case address
  vendor1: '00000000-0000-7000-8000-0000000000b1', // B2B guest, active, live session
  vendor2: '00000000-0000-7000-8000-0000000000b2', // B2B guest, never had a session
};
const OID = {
  alice: '11111111-1111-4111-8111-111111111101',
  bob: '11111111-1111-4111-8111-111111111102',
  carol: '11111111-1111-4111-8111-111111111103',
  dan: '11111111-1111-4111-8111-111111111104',
  frank: '11111111-1111-4111-8111-111111111106',
  vendor1: '11111111-1111-4111-8111-1111111111b1',
  vendor2: '11111111-1111-4111-8111-1111111111b2',
};
const WS = '22222222-2222-4222-8222-222222222222';

async function seedV7(pool: Pool): Promise<void> {
  const user = (id: string, email: string, name: string, status: string, deleted = false) =>
    pool.query(
      `insert into identity.users (id, email, display_name, status, email_verified, avatar_url, created_at, deleted_at)
       values ($1, $2, $3, $4::user_status, $5, $6, '2026-05-01T08:00:00Z', $7)`,
      [
        id,
        email,
        name,
        status,
        status === 'active',
        `https://img.example/${name}.png`,
        deleted ? new Date() : null,
      ],
    );
  await user(U.alice, 'alice@qnsc.vn', 'Alice', 'active');
  await user(U.bob, 'bob@qnsc.vn', 'Bob', 'suspended');
  await user(U.carol, 'carol@qnsc.vn', 'Carol', 'inactive');
  await user(U.dan, 'dan@qnsc.vn', 'Dan', 'active', true);
  await user(U.erin, 'erin@qnsc.vn', 'Erin', 'invited');
  await user(U.frank, 'Frank@QNSC.vn', 'Frank', 'active');
  await user(U.vendor1, 'pat@acme.example', 'Pat (Acme)', 'active');
  await user(U.vendor2, 'sam@globex.example', 'Sam (Globex)', 'active');

  const identity = (userId: string, sub: string, email: string, provider = 'entra') =>
    pool.query(
      `insert into identity.sso_identities (id, user_id, provider, provider_sub, provider_email)
       values (gen_random_uuid(), $1, $2::sso_provider, $3, $4)`,
      [userId, provider, sub, email],
    );
  await identity(U.alice, OID.alice, 'alice@qnsc.vn');
  await identity(U.bob, OID.bob, 'bob@qnsc.vn');
  await identity(U.carol, OID.carol, 'carol@qnsc.vn');
  await identity(U.dan, OID.dan, 'dan@qnsc.vn');
  await identity(U.frank, OID.frank, 'frank@qnsc.vn');
  await identity(U.vendor1, OID.vendor1, 'pat@acme.example');
  await identity(U.vendor2, OID.vendor2, 'sam@globex.example');

  const session = (userId: string, revoked: boolean, expiresInDays: number) =>
    pool.query(
      `insert into identity.auth_sessions (id, workspace_id, user_id, token_hash, family_id, is_revoked, expires_at)
       values (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), $4, now() + ($5 || ' days')::interval)`,
      [WS, userId, randomBytes(16).toString('hex'), revoked, expiresInDays],
    );
  await session(U.alice, false, 7);
  await session(U.vendor1, false, 7);
  await session(U.bob, true, 7); // revoked
  await session(U.carol, false, -1); // expired

  // The two connections rova has: the home directory tenant and the shared guest gate.
  await pool.query(
    `insert into identity.sso_connections (id, workspace_id, provider, external_tenant_id, kind, jit_enabled)
     values (gen_random_uuid(), $1, 'entra', $2, 'directory', true), (gen_random_uuid(), $1, 'entra', $3, 'shared', false)`,
    [WS, TENANT, WS],
  );
}

const table = async (pool: Pool, name: string): Promise<Array<Record<string, unknown>>> =>
  (await pool.query(`select * from ${name} order by 1`)).rows as Array<Record<string, unknown>>;
const count = async (pool: Pool, name: string): Promise<number> =>
  Number((await pool.query(`select count(*)::int n from ${name}`)).rows[0].n);
const v8Counts = async (pool: Pool) => ({
  user: await count(pool, 'identity."user"'),
  account: await count(pool, 'identity.account'),
  session: await count(pool, 'identity.session'),
});

// ── the suite ─────────────────────────────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  admin = new Client({ connectionString: baseUrl });
  await admin.connect();
});
afterAll(async () => {
  // One FORCE drop per throwaway database, in series: dozens of them outlast the 30 s default hook on a slow Docker host.
  for (const name of created) await dropDatabase(name).catch(() => undefined);
  await admin?.end();
}, 120_000);

describe('migration 0136: the v8 tables', () => {
  it('is the last journal entry, ships its rollback, and the rollback forgets exactly this migration', () => {
    const when = journalWhen(TAG);
    const rollback = readFileSync(join(V8_SQL_DIR, 'rollback.sql'), 'utf8');
    expect(rollback).toContain(`created_at = ${when}`);
    const files = readdirSync(MIGRATIONS).filter((f) => f.startsWith('0136'));
    expect(files).toEqual([`${TAG}.sql`]);
  });

  it('is additive: its SQL only creates the four tables, their indexes and constraints, and comments', () => {
    const sql = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') || l.trim() === '--> statement-breakpoint')
      .join('\n');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim().replace(/;$/, ''))
      .filter(Boolean);
    for (const statement of statements) {
      expect(statement, statement.slice(0, 60)).toMatch(
        /^(CREATE TABLE "identity"\."(user|session|account|verification)"|CREATE INDEX "[A-Za-z_]+" ON "identity"\."(session|account|verification)"|ALTER TABLE "identity"\."(session|account)" ADD CONSTRAINT "[a-z_]+" FOREIGN KEY \("user_id"\) REFERENCES "identity"\."user"|COMMENT ON (TABLE|COLUMN) "identity"\.)/,
      );
    }
    // no statement of any other kind (the words appear inside the FOREIGN KEY clauses: ON DELETE cascade, ON UPDATE no action)
    for (const statement of statements)
      expect(statement).not.toMatch(/^(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!identity"\."(session|account)")/);
  });

  it('fresh database: up, down, up', async () => {
    const name = await createDatabase();
    await migrateDatabase(name, TAG); // up TO 0136: a later migration (0137...) must not change what this proves
    await withPool(name, async (pool) => {
      // UP: the four tables, session.context_id, the keys and indexes.
      expect(await v8TablesPresent(pool)).toEqual([
        'identity.account',
        'identity.session',
        'identity.user',
        'identity.verification',
      ]);
      const columns = (
        await pool.query<{ column_name: string; data_type: string }>(
          `select column_name, data_type from information_schema.columns
           where table_schema = 'identity' and table_name = 'session' order by ordinal_position`,
        )
      ).rows;
      expect(columns).toContainEqual({ column_name: 'context_id', data_type: 'uuid' });
      expect(columns.find((c) => c.column_name === 'id')?.data_type).toBe('uuid');
      const indexes = (
        await pool.query<{ indexname: string }>(
          `select indexname from pg_indexes where schemaname = 'identity' and tablename in ('user','session','account','verification')`,
        )
      ).rows.map((r) => r.indexname);
      for (const expected of [
        'user_email_unique',
        'session_token_unique',
        'session_userId_idx',
        'account_userId_idx',
        'verification_identifier_idx',
        'account_provider_account_idx',
        'session_context_id_idx',
      ]) {
        expect(indexes).toContain(expected);
      }
      const v7 = await fingerprint(pool);
      expect(await migrationRecorded(pool, journalWhen(TAG))).toBe(true);

      // The new tables get the same privileges as a table created by an earlier migration (default privileges, 0068).
      const acl = async (t: string) =>
        (
          await pool.query<{ acl: string | null }>(
            `select relacl::text acl from pg_class where oid = $1::regclass`,
            [t],
          )
        ).rows[0].acl;
      const reference = await acl('identity.api_tokens');
      expect(reference).toBeTruthy();
      for (const t of [
        'identity."user"',
        'identity.session',
        'identity.account',
        'identity.verification',
      ]) {
        expect(await acl(t), t).toBe(reference);
      }

      // DOWN: exactly those four tables and the migration record go; nothing else changes.
      await withClient(name, (client) => runRollback(client));
      expect(await v8TablesPresent(pool)).toEqual([]);
      expect(await migrationRecorded(pool, journalWhen(TAG))).toBe(false);
      expect(await fingerprint(pool, [])).toEqual(v7);
    });

    // UP AGAIN: `db:migrate` applies it again, because the rollback forgot it.
    await migrateDatabase(name, TAG);
    await withPool(name, async (pool) => {
      expect(await v8TablesPresent(pool)).toEqual([
        'identity.account',
        'identity.session',
        'identity.user',
        'identity.verification',
      ]);
      expect(await migrationRecorded(pool, journalWhen(TAG))).toBe(true);
    });
  });

  it('the rollback refuses to drop rows unless it is told to, and says why', async () => {
    const name = await createDatabase();
    await migrateDatabase(name, TAG);
    await withPool(name, async (pool) => {
      await pool.query(
        `insert into identity."user" (id, name, email) values ($1, 'x', 'x@qnsc.vn')`,
        [randomUUID()],
      );
      await expect(withClient(name, (client) => runRollback(client))).rejects.toThrow(
        /rollback refused.*holds 1 row/s,
      );
      expect(await v8TablesPresent(pool)).toHaveLength(4); // nothing dropped
      expect(await migrationRecorded(pool, journalWhen(TAG))).toBe(true);

      await withClient(name, (client) => runRollback(client, { allowDataLoss: true }));
      expect(await v8TablesPresent(pool)).toEqual([]);
    });
  });

  it('the rollback refuses once a LATER migration is recorded: forgetting 0136 would not make drizzle apply it again', async () => {
    const name = await createDatabase();
    await migrateDatabase(name, TAG);
    await withPool(name, async (pool) => {
      // What a 0137 would leave behind: a row newer than 0136's.
      await pool.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ('later', $1)`,
        [journalWhen(TAG) + 1],
      );
      await expect(
        withClient(name, (client) => runRollback(client, { allowDataLoss: true })),
      ).rejects.toThrow(/newer than 0136 is recorded.*Roll forward/s);
      expect(await v8TablesPresent(pool)).toHaveLength(4);
      expect(await migrationRecorded(pool, journalWhen(TAG))).toBe(true);
    });
  });

  it('a database that already has rova’s schema AND v7 data: applying 0136 changes none of it', async () => {
    const name = await createDatabase();
    await migrateDatabase(name, '0135_outbox_lease_and_fence'); // exactly what production has today
    const before = await withPool(name, async (pool) => {
      expect(await v8TablesPresent(pool)).toEqual([]);
      await seedV7(pool);
      return fingerprint(pool, []);
    });
    expect(Object.keys(before).length).toBeGreaterThan(50); // the whole schema, not a handful of tables

    await migrateDatabase(name, TAG); // applies 0136 only
    await withPool(name, async (pool) => {
      expect(await v8TablesPresent(pool)).toHaveLength(4);
      const after = await fingerprint(pool);
      expect(after).toEqual(before); // every other table: columns, indexes, constraints, triggers, rows
      expect(await v8Counts(pool)).toEqual({ user: 0, account: 0, session: 0 }); // and the new ones are empty
    });
  });
});

describe('the backfill, on a seeded copy with guests and vendors', () => {
  let template: string;

  /** A migrated database with v7 data; `mutate` adjusts it before the test runs. Cloned from a template (fast). */
  async function seededCopy(mutate?: (pool: Pool) => Promise<void>): Promise<string> {
    const name = await createDatabase(template);
    if (mutate) await withPool(name, mutate);
    return name;
  }
  const backfill = (name: string, over: Partial<BackfillOptions> = {}) =>
    withClient(name, (client) => runBackfill(client, { ...OPTS, database: name, ...over }));

  beforeAll(async () => {
    template = await createDatabase();
    await migrateDatabase(template, TAG);
    await withPool(template, seedV7);
  }, 120_000);

  it('a dry run does everything, checks everything, and writes nothing', async () => {
    const name = await seededCopy();
    const summary = await backfill(name, { commit: false });
    expect(summary['v8 users']).toBe(7); // alice bob carol erin frank vendor1 vendor2; NOT dan (soft-deleted)
    await withPool(name, async (pool) =>
      expect(await v8Counts(pool)).toEqual({ user: 0, account: 0, session: 0 }),
    );
  });

  it('maps users and accounts: verified, banned by status, every Entra identity (guests included) an account, deleted users skipped', async () => {
    const name = await seededCopy();
    await withPool(name, async (pool) => {
      const v7Before = await fingerprint(pool);
      const summary = await backfill(name);
      expect(summary).toMatchObject({
        'v7 live users': 7,
        'v7 soft-deleted users (not copied)': 1,
        'v8 users': 7,
        'v8 users banned': 2,
        'v8 microsoft accounts': 6,
        'v8 users without an account (staff domain, link on first sign-in)': 1,
        'v8 sessions': 0, // sessions are NOT migrated: everyone signs in once
      });

      const users: Record<string, Record<string, unknown>> = Object.fromEntries(
        (await table(pool, 'identity."user"')).map((r) => [String(r.id), r]),
      );
      expect(users[U.dan]).toBeUndefined();
      expect(users[U.alice]).toMatchObject({
        name: 'Alice',
        email: 'alice@qnsc.vn',
        email_verified: true,
        banned: false,
        ban_reason: null,
      });
      expect(users[U.alice].image).toBe('https://img.example/Alice.png');
      expect(users[U.bob]).toMatchObject({
        banned: true,
        ban_reason: 'migrated from v7: suspended',
        email_verified: true,
      });
      expect(users[U.carol]).toMatchObject({
        banned: true,
        ban_reason: 'migrated from v7: inactive',
      });
      expect(users[U.erin]).toMatchObject({ banned: false, email_verified: true }); // 'invited': copied, verified, no account
      expect(users[U.frank]?.['email']).toBe('frank@qnsc.vn'); // lower-cased
      for (const u of Object.values(users)) expect(u['email_verified'], String(u['id'])).toBe(true);

      const accounts = (await table(pool, 'identity.account')) as Array<{
        user_id: string;
        account_id: string;
        provider_id: string;
      }>;
      const byUser = Object.fromEntries(accounts.map((a) => [a.user_id, a]));
      expect(accounts).toHaveLength(6);
      for (const a of accounts) expect(a.provider_id).toBe('microsoft');
      // the vendors: without this row a guest whose address has a v8 user is refused (ACCOUNT_LINK_REQUIRED)
      expect(byUser[U.vendor1].account_id).toBe(OID.vendor1);
      expect(byUser[U.vendor2].account_id).toBe(OID.vendor2);
      expect(byUser[U.alice].account_id).toBe(OID.alice);
      expect(byUser[U.erin]).toBeUndefined();
      expect(byUser[U.dan]).toBeUndefined();

      expect(await fingerprint(pool)).toEqual(v7Before); // it reads v7 and changes none of it
    });
  });

  it('is idempotent, and a re-run picks up users created in v7 since', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      const first = {
        users: await table(pool, 'identity."user"'),
        accounts: await table(pool, 'identity.account'),
      };
      await backfill(name);
      expect({
        users: await table(pool, 'identity."user"'),
        accounts: await table(pool, 'identity.account'),
      }).toEqual(first);

      const late = '00000000-0000-7000-8000-0000000000c1';
      await pool.query(
        `insert into identity.users (id, email, display_name, status) values ($1, 'late@qnsc.vn', 'Late', 'active')`,
        [late],
      );
      await pool.query(
        `insert into identity.sso_identities (id, user_id, provider, provider_sub, provider_email)
         values (gen_random_uuid(), $1, 'entra', $2, 'late@qnsc.vn')`,
        [late, randomUUID()],
      );
      const summary = await backfill(name);
      expect(summary['v8 users']).toBe(8);
      expect(summary['v8 microsoft accounts']).toBe(7);
    });
  });

  it('a re-run carries what v7 changed since: a rename, a new avatar, a suspension, and a user deleted in v7 is banned in v8', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      await pool.query(
        `update identity.users set display_name = 'Alice Renamed', avatar_url = null where id = $1`,
        [U.alice],
      );
      await pool.query(`update identity.users set status = 'suspended' where id = $1`, [U.vendor2]);
      await pool.query(`update identity.users set deleted_at = now() where id = $1`, [U.frank]);

      const summary = await backfill(name);
      expect(summary['v7 live users']).toBe(6);
      const users = Object.fromEntries(
        (await table(pool, 'identity."user"')).map((r) => [String(r['id']), r]),
      );
      expect(users[U.alice]).toMatchObject({ name: 'Alice Renamed', image: null, banned: false });
      expect(users[U.vendor2]).toMatchObject({
        banned: true,
        ban_reason: 'migrated from v7: suspended',
      });
      expect(users[U.frank]).toMatchObject({
        banned: true,
        ban_reason: 'migrated from v7: deleted',
      }); // kept, but cannot sign in
      // and a third run is a no-op
      const before = await table(pool, 'identity."user"');
      await backfill(name);
      expect(await table(pool, 'identity."user"')).toEqual(before);
    });
  });

  it('a re-run after a B2B guest signed in on v8 (a Microsoft account, no v7 identity, an unverified address) still passes', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      const guest = '00000000-0000-7000-8000-0000000000c1';
      await pool.query(
        `insert into identity.users (id, email, display_name) values ($1, 'new.vendor@vendor.example', 'New Vendor')`,
        [guest],
      );
      await pool.query(
        `insert into identity."user" (id, name, email, email_verified) values ($1, 'New Vendor', 'new.vendor@vendor.example', false)`,
        [guest],
      );
      await pool.query(
        `insert into identity.account (id, account_id, provider_id, user_id, created_at, updated_at) values (gen_random_uuid(), '22222222-2222-4222-8222-222222222201', 'microsoft', $1, now(), now())`,
        [guest],
      );
      const summary = await backfill(name);
      expect(summary['v8 users']).toBe(8);
    });
  });

  it('a re-run never lifts a ban placed in v8, and keeps its reason', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      await pool.query(
        `update identity."user" set banned = true, ban_reason = 'offboarded in v8' where id = $1`,
        [U.alice],
      );
      await backfill(name);
      const [alice] = await pool
        .query(`select banned, ban_reason from identity."user" where id = $1`, [U.alice])
        .then((r) => r.rows as Array<Record<string, unknown>>);
      expect(alice).toMatchObject({ banned: true, ban_reason: 'offboarded in v8' });
      // and a v7 suspension still arrives: bob is suspended in v7 and banned with the migrated reason
      const [bob] = await pool
        .query(`select banned, ban_reason from identity."user" where id = $1`, [U.bob])
        .then((r) => r.rows as Array<Record<string, unknown>>);
      expect(bob).toMatchObject({ banned: true, ban_reason: 'migrated from v7: suspended' });
    });
  });

  describe('committed by the migrator as part of a deploy (IDENTITY_V8_BACKFILL=commit): the production cutover', () => {
    // After the migrations and before the API rolls; opt-in per environment; a raise FAILS (so the deploy fails and v7 keeps serving).
    const env = { ENTRA_TENANT_ID: TENANT, SSO_ALLOWED_EMAIL_DOMAINS: 'qnsc.vn' };

    it('does nothing without the flag, and refuses a value that is not "commit"', async () => {
      const name = await seededCopy();
      await withPool(name, async (pool) => {
        expect(await runBackfillIfRequested(pool, env)).toBeNull();
        expect(await runBackfillIfRequested(pool, { ...env, IDENTITY_V8_BACKFILL: '' })).toBeNull();
        await expect(
          runBackfillIfRequested(pool, { ...env, IDENTITY_V8_BACKFILL: 'dry' }),
        ).rejects.toThrow(/must be "commit" or unset/);
        expect((await table(pool, 'identity."user"')).length).toBe(0);
      });
    });

    it('with the flag, commits (database name read from the connection) and reports the counts', async () => {
      const name = await seededCopy();
      await withPool(name, async (pool) => {
        const infos: string[] = [];
        const summary = await runBackfillIfRequested(
          pool,
          { ...env, IDENTITY_V8_BACKFILL: 'commit' },
          { info: (m) => infos.push(m) },
        );
        expect(summary?.['v8 users']).toBe(7);
        expect(infos.join(' ')).toContain('COMMITTED');
        expect((await table(pool, 'identity."user"')).length).toBe(7);
      });
    });

    it('FAILS and writes nothing when the preflight raises: the deploy fails, the previous tasks keep serving', async () => {
      const name = await seededCopy(async (pool) => {
        await pool.query(
          `insert into identity.users (id, email, display_name) values (gen_random_uuid(), 'outsider@elsewhere.example', 'Outsider')`,
        );
      });
      await withPool(name, async (pool) => {
        await expect(
          runBackfillIfRequested(pool, { ...env, IDENTITY_V8_BACKFILL: 'commit' }),
        ).rejects.toThrow(/outside the staff domains/);
        expect((await table(pool, 'identity."user"')).length).toBe(0);
      });
    });
  });

  it('a re-run follows v7 for a ban the backfill itself placed: un-suspended in v7 means un-banned, and mirror-bans does not re-suspend them', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      const bannedOf = async (id: string) =>
        (
          (await pool.query(`select banned from identity."user" where id = $1`, [id]))
            .rows as Array<{
            banned: boolean;
          }>
        )[0].banned;
      expect(await bannedOf(U.bob), 'suspended in v7: banned by the backfill').toBe(true);

      await pool.query(`update identity.users set status = 'active' where id = $1`, [U.bob]);
      await backfill(name);
      expect(await bannedOf(U.bob), 'un-suspended in v7: un-banned by the re-run').toBe(false);

      // and a ban the backfill placed is v7's own: mirroring it back would be circular
      await pool.query(`update identity.users set status = 'suspended' where id = $1`, [U.bob]);
      await backfill(name);
      expect(await bannedOf(U.bob)).toBe(true);
      const mirrored = await withClient(name, (c) => runMirrorBans(c));
      expect(mirrored['v7 users changed by this run']).toBe(0);
    });
  });

  it('mirror-bans marks a v8-only ban suspended in v7 before a rollback, dry run by default, and needs --database to commit', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      await pool.query(`update identity."user" set banned = true, ban_reason = 'x' where id = $1`, [
        U.alice,
      ]);
      const statusOf = async (id: string) =>
        String(
          (
            (await pool.query(`select status from identity.users where id = $1`, [id]))
              .rows as Array<{ status: unknown }>
          )[0].status,
        );

      await withClient(name, (c) => runMirrorBans(c));
      expect(await statusOf(U.alice), 'a dry run writes nothing').toBe('active');

      await expect(withClient(name, (c) => runMirrorBans(c, { commit: true }))).rejects.toThrow(
        /--commit needs --database/,
      );

      const summary = await withClient(name, (c) =>
        runMirrorBans(c, { commit: true, database: name }),
      );
      expect(await statusOf(U.alice)).toBe('suspended');
      expect(await statusOf(U.bob), 'already suspended in v7: untouched').toBe('suspended');
      expect(await statusOf(U.vendor1), 'not banned: untouched').toBe('active');
      expect(summary['v7 users changed by this run']).toBe(1);
      expect(summary[`v7 user marked suspended: ${U.alice}`], 'the ids are printed').toBe(1);

      // idempotent, and it says so
      const again = await withClient(name, (c) =>
        runMirrorBans(c, { commit: true, database: name }),
      );
      expect(again['v7 users changed by this run']).toBe(0);
    });
  });

  it('a soft-deleted user with a live v7 session and no Entra identity does not block it', async () => {
    const name = await seededCopy(async (pool) => {
      const ghost = '00000000-0000-7000-8000-0000000000d1';
      await pool.query(
        `insert into identity.users (id, email, display_name, deleted_at) values ($1, 'ghost@qnsc.vn', 'Ghost', now())`,
        [ghost],
      );
      await pool.query(
        `insert into identity.auth_sessions (id, workspace_id, user_id, token_hash, family_id, expires_at)
         values (gen_random_uuid(), $1, $2, 'ghost', gen_random_uuid(), now() + interval '1 day')`,
        [WS, ghost],
      );
    });
    expect((await backfill(name))['v8 users']).toBe(7);
  });

  it('--commit needs the database to be named, and named correctly', async () => {
    const name = await seededCopy();
    await expect(backfill(name, { database: undefined })).rejects.toThrow(
      /--commit needs --database/,
    );
    await expect(backfill(name, { database: 'some_other_db' })).rejects.toThrow(
      /--commit needs --database/,
    );
    await withPool(name, async (pool) =>
      expect(await v8Counts(pool)).toEqual({ user: 0, account: 0, session: 0 }),
    );
    // a dry run never needs it
    await expect(backfill(name, { commit: false, database: undefined })).resolves.toBeTruthy();
  });

  it('after v8 sign-ins have started (v8 sessions exist), a re-run still agrees with v7', async () => {
    const name = await seededCopy();
    await backfill(name);
    await withPool(name, async (pool) => {
      await pool.query(
        `insert into identity.session (id, expires_at, token, updated_at, user_id, context_id)
         values (gen_random_uuid(), now() + interval '1 day', 't1', now(), $1, $2)`,
        [U.alice, WS],
      );
      const summary = await backfill(name);
      expect(summary['v8 sessions']).toBe(1);
    });
  });

  describe('refuses, loudly and before writing anything, what it cannot map', () => {
    const refuses = (
      title: string,
      mutate: (pool: Pool) => Promise<void>,
      message: RegExp,
      over: Partial<BackfillOptions> = {},
    ) =>
      it(title, async () => {
        const name = await seededCopy(mutate);
        // What the test itself put in the v8 tables (some refusals need a pre-existing v8 row) is the baseline: the backfill
        // must add NOTHING to it.
        const baseline = await withPool(name, (pool) => v8Counts(pool));
        await expect(backfill(name, over)).rejects.toThrow(message);
        await withPool(name, async (pool) => expect(await v8Counts(pool)).toEqual(baseline));
      });

    refuses(
      'two live users whose addresses differ only by case',
      async (pool) => {
        await pool.query(
          `insert into identity.users (id, email, display_name) values (gen_random_uuid(), 'ALICE@qnsc.vn', 'Alice twin')`,
        );
      },
      /shared by more than one live user once lower-cased/,
    );
    refuses(
      'an identity of a provider v8 cannot map',
      async (pool) => {
        await pool.query(
          `insert into identity.sso_identities (id, user_id, provider, provider_sub, provider_email)
           values (gen_random_uuid(), $1, 'google', 'g-1', 'alice@qnsc.vn')`,
          [U.alice],
        );
      },
      /provider other than entra/,
    );
    refuses(
      'a user with two Entra identities',
      async (pool) => {
        await pool.query(
          `insert into identity.sso_identities (id, user_id, provider, provider_sub, provider_email)
           values (gen_random_uuid(), $1, 'entra', $2, 'alice@qnsc.vn')`,
          [U.alice, randomUUID()],
        );
      },
      /more than one Entra identity/,
    );
    refuses(
      'a pre-invited outsider: no Entra identity and an address off the staff domains',
      async (pool) => {
        await pool.query(
          `insert into identity.users (id, email, display_name, status) values (gen_random_uuid(), 'outsider@elsewhere.example', 'Out', 'invited')`,
        );
      },
      /no Entra identity and an address outside the staff domains/,
    );
    refuses(
      'an address that merely CONTAINS a staff domain before another @ is not a staff address',
      async (pool) => {
        await pool.query(
          `insert into identity.users (id, email, display_name, status) values (gen_random_uuid(), 'x@qnsc.vn@evil.example', 'Tricky', 'invited')`,
        );
      },
      /no Entra identity and an address outside the staff domains/,
    );
    refuses(
      'any sso connection beyond the home directory and the shared gate (partner SSO is deferred)',
      async (pool) => {
        await pool.query(
          `insert into identity.sso_connections (id, workspace_id, provider, external_tenant_id, kind)
           values (gen_random_uuid(), $1, 'entra', 'some-partner-tenant', 'directory')`,
          [WS],
        );
      },
      /neither the home directory connection.*nor a shared guest gate/s,
    );
    refuses(
      'the home tenant id the operator passes does not match the seeded connection',
      async () => undefined,
      /neither the home directory connection/,
      { tenantId: 'a-different-tenant' },
    );
    refuses(
      'an owner of a live v7 session with no Entra identity (a dev-login session)',
      async (pool) => {
        await pool.query(
          `insert into identity.auth_sessions (id, workspace_id, user_id, token_hash, family_id, expires_at)
           values (gen_random_uuid(), $1, $2, 'dev', gen_random_uuid(), now() + interval '1 day')`,
          [WS, U.erin],
        );
      },
      /owner\(s\) of a live v7 session have no Entra identity/,
    );
    refuses(
      'an existing v8 user with the same address under another id',
      async (pool) => {
        await pool.query(
          `insert into identity."user" (id, name, email) values (gen_random_uuid(), 'imposter', 'alice@qnsc.vn')`,
        );
      },
      /clash with an existing v8 user/,
    );
    refuses(
      'an Entra oid already attached to a different v8 user',
      async (pool) => {
        const other = randomUUID();
        await pool.query(
          `insert into identity."user" (id, name, email) values ($1, 'other', 'other@qnsc.vn')`,
          [other],
        );
        await pool.query(
          `insert into identity.account (id, account_id, provider_id, user_id, updated_at) values (gen_random_uuid(), $1, 'microsoft', $2, now())`,
          [OID.alice, other],
        );
      },
      /already attached to a DIFFERENT v8 user/,
    );
    refuses('no tenant id', async () => undefined, /tenantId is required/, { tenantId: ' ' });
    refuses('no staff domain', async () => undefined, /at least one staff domain/, {
      staffDomains: [],
    });
    refuses('a staff domain that is not a domain', async () => undefined, /not a domain name/, {
      staffDomains: ["qnsc.vn'; drop table x"],
    });

    it('does not run before the migration has', async () => {
      const name = await createDatabase();
      await migrateDatabase(name, '0135_outbox_lease_and_fence');
      await expect(backfill(name)).rejects.toThrow(/the v8 tables do not exist/);
    });

    it('names ids and counts in what it says, never an address', async () => {
      const name = await seededCopy(async (pool) => {
        await pool.query(
          `insert into identity.users (id, email, display_name) values (gen_random_uuid(), 'ALICE@qnsc.vn', 'Alice twin')`,
        );
      });
      const error = await backfill(name).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message).toBeTruthy();
      expect(error!.message).not.toMatch(/@/);
    });
  });

  describe('the assertions fail loudly when the result is corrupted (they are not decoration)', () => {
    // Run the assertions section of backfill.sql on its own, after a good backfill, with ONE thing broken in a
    // transaction that is rolled back.
    // The assertions read the staff domains the runner sets as a transaction-local setting; set it the way the runner does.
    const STAFF_SETTINGS = "SELECT set_config('rova.v8_staff_domains', 'qnsc.vn', true)";
    const sql = readFileSync(join(V8_SQL_DIR, 'backfill.sql'), 'utf8');
    const assertions = sql.slice(sql.indexOf('-- ── 4.'), sql.indexOf('-- ── 5.'));
    let committed: string;

    beforeAll(async () => {
      committed = await seededCopy();
      await backfill(committed);
    });

    const fails = (title: string, corrupt: string, message: RegExp) =>
      it(title, async () => {
        await withClient(committed, async (client) => {
          await client.query('BEGIN');
          try {
            await client.query(STAFF_SETTINGS);
            await client.query(corrupt);
            await expect(client.query(assertions)).rejects.toThrow(message);
          } finally {
            await client.query('ROLLBACK');
          }
        });
      });

    it('passes on the real result (the section is the real one)', async () => {
      expect(assertions.length).toBeGreaterThan(500);
      await withClient(committed, async (client) => {
        await client.query(`${STAFF_SETTINGS};\n${assertions}`);
      });
    });

    fails(
      'a live v7 user with no v8 user',
      `delete from identity."user" where id = '${U.frank}'`,
      /no v8 user with the same id and address/,
    );
    fails(
      'a v8 user with another address',
      `update identity."user" set email = 'moved@qnsc.vn' where id = '${U.alice}'`,
      /no v8 user with the same id and address/,
    );
    fails(
      'a v8 user that is no live profile',
      `insert into identity."user" (id, name, email) values (gen_random_uuid(), 'ghost', 'ghost@qnsc.vn')`,
      /not a live profile/,
    );
    fails(
      'a vendor without an account (the ACCOUNT_LINK_REQUIRED case)',
      `delete from identity.account where user_id = '${U.vendor1}'`,
      /no matching v8 account/,
    );
    fails(
      'an account with the wrong oid',
      `update identity.account set account_id = 'wrong' where user_id = '${U.alice}'`,
      /no matching v8 account/,
    );
    fails(
      'a user with two Microsoft accounts',
      `insert into identity.account (id, account_id, provider_id, user_id, updated_at) values (gen_random_uuid(), 'second', 'microsoft', '${U.alice}', now())`,
      /not have exactly one Microsoft account/,
    );
    fails(
      'a session owner whose account is gone',
      `delete from identity.account where user_id = '${U.alice}'`,
      /no matching v8 account|owner\(s\) of a live v7 session/,
    );
    fails(
      'the wrong banned flag',
      `update identity."user" set banned = false where id = '${U.bob}'`,
      /inactive or suspended in v7 and not banned in v8/,
    );
    fails(
      'an unverified migrated user',
      `update identity."user" set email_verified = false where id = '${U.alice}'`,
      /not email_verified/,
    );
  });
});

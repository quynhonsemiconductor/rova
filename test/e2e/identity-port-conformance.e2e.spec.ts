/**
 * The shared identity package's port-conformance suites, run against THIS repo's
 * real Drizzle adapters.
 *
 * WHY THIS FILE EXISTS. The port interfaces pin method names and types, and the
 * compiler checks those. What they cannot express is the SEMANTICS the shared auth
 * logic depends on — and that is exactly where a Drizzle adapter goes wrong
 * silently. `revokeByIdIfActive` returning `true` unconditionally still typechecks,
 * and turns single-use refresh rotation into a token that can be replayed for ever.
 * Nothing in this repo tested that; the suite in
 * `@quynhonsemiconductor/identity/testing` does, and until now had zero consumers.
 *
 * WHY IT IS AN E2E SPEC. The contract's whole value is being run against a REAL
 * database. The in-memory ports already pass it inside the package — running it
 * here against Postgres is the only thing that says anything new. It therefore
 * needs the e2e config's real DB, not the unit config.
 *
 * The suite takes `describe`/`it`/`expect` from vitest globals rather than
 * importing them, so it adds no framework dependency to the package. This config
 * sets `globals: true`, which is what makes that work.
 */
import {
  describeAuthSessionRepositoryContract,
  SESSION_CONTRACT_USER_IDS,
} from '@quynhonsemiconductor/identity/testing';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '@platform';
// Deep import: the module barrel exports the Nest module and its HTTP DTOs, not
// the persistence adapters. Reaching for the class directly is the accepted shape
// here for the same reason WorkspaceService deep-imports ApiTokensService — the
// barrel would close a cycle.
import { AuthSessionDrizzleRepository } from '@modules/identity/infrastructure/persistence/auth-session.drizzle-repository';
import { authSessions } from '@db/schema/identity';
import { bootRallyApp } from './support/flow-harness';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let app: NestFastifyApplication;
let db: DrizzleDB;

/**
 * The suite's fixture names ('session-1', 'user-1') are LOGICAL. Every id column
 * here is `uuid`, and Postgres rejects 'session-1' with `22P02 invalid input syntax
 * for type uuid` before a single assertion runs — which is why the contract takes
 * this mapper at all.
 *
 * Deterministic by construction: the suite maps the same logical name more than
 * once and compares the results, so a random uuid per call would fail every
 * identity assertion. A fixed prefix plus a stable per-name counter gives a real
 * v4-shaped uuid that is the same every time within a run.
 */
const ids = new Map<string, string>();
const toUuid = (logical: string): string => {
  const existing = ids.get(logical);
  if (existing) return existing;
  const n = (ids.size + 1).toString(16).padStart(12, '0');
  const uuid = `00000000-0000-7000-8000-${n}`;
  ids.set(logical, uuid);
  return uuid;
};

beforeAll(async () => {
  app = await bootRallyApp();
  db = app.get<DrizzleDB>(DRIZZLE);
});

afterAll(async () => {
  await app?.close();
});

describeAuthSessionRepositoryContract({
  name: 'AuthSessionDrizzleRepository',
  id: toUuid,

  /**
   * The contract requires a FRESH, EMPTY repository per test. Against a shared real
   * database that means removing the previous test's rows — otherwise the suite's
   * own fixtures collide on `uq_auth_sessions_token_hash` from the second test
   * onwards, and the failure reads as a broken adapter rather than as leaked state.
   *
   * A DELETE scoped to this suite's own user ids, NOT a TRUNCATE. `e2e-fixtures
   * .ratchet.spec.ts` forbids a file resetting on its own, and it is right to: a
   * per-file truncate fights `global-setup.ts` and makes other specs' failures
   * depend on file order. Every row this contract creates carries one of the two
   * seeded user ids, so this removes exactly the suite's rows and cannot touch
   * another spec's fixtures — which a TRUNCATE would.
   */
  create: async () => {
    // drizzle's query builder, not a hand-built SQL literal: `sql.raw` with
    // interpolated values is the shape db/migrate.ts was burned by (it produced a
    // 42601 on the first real migration run), and there is no reason to reach for it
    // when `inArray` parameterises this correctly.
    await db
      .delete(authSessions)
      .where(inArray(authSessions.userId, SESSION_CONTRACT_USER_IDS.map(toUuid)));
    return new AuthSessionDrizzleRepository(db);
  },

  /**
   * `auth_sessions.user_id` carries no foreign key in this schema, so the inserts
   * would succeed without this. Seeding anyway is deliberate: it keeps the fixtures
   * referentially honest, and if a future migration adds the FK — which it should —
   * this suite keeps passing instead of failing for a reason unrelated to the
   * behaviour under test.
   */
  seedUsers: async (userIds) => {
    for (const userId of userIds) {
      await db.execute(sql`
        INSERT INTO identity.users (id, email, display_name)
        VALUES (${userId}, ${`conformance+${userId}@example.test`}, 'Port conformance')
        ON CONFLICT (id) DO NOTHING
      `);
    }
  },
});

/**
 * Exported only so the suite's own fixture ids are greppable from a failing run —
 * a bare uuid in an assertion message is otherwise impossible to trace back here.
 */
export const CONFORMANCE_USER_IDS = SESSION_CONTRACT_USER_IDS;

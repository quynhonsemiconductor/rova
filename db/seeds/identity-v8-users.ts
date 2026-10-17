import { sql } from 'drizzle-orm';
import type { Db } from './constants';

/**
 * Give every live profile (`identity.users`) its identity 8 user (`identity."user"`) with the SAME id.
 *
 * Under identity 8 a person signs in against `identity."user"`; the profile table stays the person (decision of the plan:
 * `identity.users.id = identity."user".id`). A seeded fixture needs both rows, or `POST /api/auth/test-login` (which looks
 * the user up by address) would mint a NEW user with a new id and every foreign key to the fixture would point at a
 * stranger. This is the seed-time equivalent of the cutover backfill (`db/identity-v8/backfill.sql`), without its
 * preflight: a developer's database has no v7 history to protect. Idempotent.
 */
export async function mirrorIdentityUsers(db: Db): Promise<void> {
  await db.execute(sql`
    INSERT INTO identity."user" (id, name, email, email_verified, image, created_at, updated_at)
    SELECT id, display_name, lower(email), true, avatar_url, created_at, now()
    FROM identity.users
    WHERE deleted_at IS NULL
    ON CONFLICT (id) DO NOTHING
  `);
}

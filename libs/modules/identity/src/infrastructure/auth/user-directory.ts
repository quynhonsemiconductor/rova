import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { users } from '../../../../../../db/schema/identity';
import { workspaceInvitations } from '../../../../../../db/schema/workspace';

export type Profile = typeof users.$inferSelect;

/**
 * rova's user profile table (`identity.users`), which stays the profile table under identity 8 (decision of the plan):
 * ids unchanged, `identity.users.id = identity."user".id`. Identity 8 owns authentication in `identity."user"`; this owns
 * the person (locale, timezone, phone, avatar, the foreign key every table in the product points at).
 */
@Injectable()
export class UserDirectory {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findById(id: string): Promise<Profile | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByEmail(email: string): Promise<Profile | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email.toLowerCase().trim()), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create the profile for a user identity just created, with the SAME id. A no-op when it is there (a retried
   * sign-in): `ON CONFLICT (id)` only, so an address clash with a different id still raises and the sign-in is refused.
   */
  async insertProfile(input: { id: string; email: string; displayName: string }): Promise<void> {
    await this.db
      .insert(users)
      .values({
        id: input.id,
        email: input.email.toLowerCase().trim(),
        displayName: input.displayName,
        status: 'active',
        emailVerified: true, // the tenant vouches for the address
      })
      .onConflictDoNothing({ target: users.id });
  }

  /** The editable profile fields of the caller. Returns the row, or null when the profile is gone. */
  async updateProfile(
    id: string,
    input: {
      displayName?: string;
      avatarUrl?: string | null;
      locale?: string;
      timezone?: string;
      phone?: string | null;
    },
  ): Promise<Profile | null> {
    const rows = await this.db
      .update(users)
      .set({
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
        ...(input.locale !== undefined && { locale: input.locale }),
        ...(input.timezone !== undefined && { timezone: input.timezone }),
        ...(input.phone !== undefined && { phone: input.phone }),
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .returning();
    return rows[0] ?? null;
  }

  async touchLastLogin(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  /**
   * A LIVE (pending, unexpired) invitation to `workspaceId` for this address, or addressed to this directory object.
   * The status alone is not the question: a cron flips rows to `expired`, so between a row's expiry and the next tick it
   * is still `pending` and must not admit anyone. The timestamp is authoritative.
   */
  async hasLiveInvitation(workspaceId: string, email: string, oid: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          eq(workspaceInvitations.status, 'pending'),
          gt(workspaceInvitations.expiresAt, new Date()),
          or(
            sql`lower(${workspaceInvitations.email}) = ${email.toLowerCase()}`,
            sql`${workspaceInvitations.entraGuestObjectId}::text = ${oid.toLowerCase()}`,
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}

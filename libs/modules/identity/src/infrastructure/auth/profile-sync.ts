import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle, NotFoundException, type DrizzleDB } from '@platform';
import { user as identityUser } from '../../../../../../db/schema/identity-auth';
import { UserDirectory, type Profile } from './user-directory';

/**
 * Edits the profile (`identity.users`, the source of truth for the person) and keeps the name and avatar on identity's
 * own `"user"` row in step, best-effort: authentication never reads them, the backfill re-run would copy them again, and a
 * failure here must not undo a profile edit that has already committed.
 */
@Injectable()
export class ProfileSync {
  private readonly logger = new Logger(ProfileSync.name);

  constructor(
    private readonly directory: UserDirectory,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async updateProfile(
    id: string,
    input: Parameters<UserDirectory['updateProfile']>[1],
  ): Promise<Profile> {
    const updated = await this.directory.updateProfile(id, input);
    if (!updated) throw new NotFoundException('USER_NOT_FOUND', 'User not found');
    if (input.displayName !== undefined || input.avatarUrl !== undefined) {
      try {
        await this.db
          .update(identityUser)
          .set({ name: updated.displayName, image: updated.avatarUrl, updatedAt: new Date() })
          .where(eq(identityUser.id, id));
      } catch (err) {
        this.logger.warn({ err: (err as Error).name, userId: id }, 'identity.user mirror failed');
      }
    }
    return updated;
  }
}

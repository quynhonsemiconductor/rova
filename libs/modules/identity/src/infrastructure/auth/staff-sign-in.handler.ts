import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@platform';
import { AccessService } from '@modules/access';
import { WorkspaceService } from '@modules/workspace';
import { AuditService } from '@modules/audit';
import { UserDirectory } from './user-directory';
import { HOME_WORKSPACE_ID } from './home-workspace';

/** Thrown to refuse a sign-in: identity removes the user this sign-in created and redirects with `STAFF_SIGN_IN_REFUSED`. */
export class StaffSignInRefusedError extends Error {
  override readonly name = 'StaffSignInRefusedError';
  constructor(
    readonly code:
      'USER_DEACTIVATED' | 'PROFILE_ID_MISMATCH' | 'SSO_JIT_DISABLED' | 'SSO_NO_ACCESS',
    message: string,
  ) {
    super(message);
  }
}

export interface StaffSignIn {
  user: { id: string; email: string; name: string };
  claims: { oid: string; email: string; guest: boolean; roles: string[] };
}

/**
 * Product policy for a Microsoft sign-in, run by identity's `hooks.onStaffSignIn` AFTER the token passed every check
 * (tenant, address on a staff domain unless a guest, no second Microsoft identity) and BEFORE the session exists.
 * It is the v7 `AuthService.ssoLoginWithWorkspace` / `assertConnectionAllows` / `provisionIntoConnection`, minus what
 * identity now owns (the token, the user row, the account link, the session):
 *
 *  - the profile row (`identity.users`) exists with the SAME id as the identity user;
 *  - ADMISSION: a staff address is admitted when JIT is on (`SSO_JIT_ENABLED`), or it already has a profile, a live
 *    invitation, or is a platform admin; a B2B GUEST (a vendor) is admitted only with a profile or a live invitation
 *    (by address or by directory object): the invitation is the whole authorization boundary for an external;
 *  - the user is enrolled in the home workspace (idempotent), and a platform admin is elevated to workspace admin.
 *
 * A throw refuses the sign-in and leaves no row for the person this sign-in created. Every message names ids, never an
 * address.
 */
@Injectable()
export class StaffSignInHandler {
  private readonly logger = new Logger(StaffSignInHandler.name);

  constructor(
    private readonly directory: UserDirectory,
    private readonly workspaces: WorkspaceService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async handle({ user, claims }: StaffSignIn): Promise<void> {
    const email = user.email.toLowerCase().trim();
    const workspaceId = HOME_WORKSPACE_ID;

    // A soft-deleted profile is a person who was removed, not a person who has not arrived yet: refuse, never create a session on it.
    const existing = await this.directory.findAnyById(user.id);
    if (existing?.deletedAt) {
      throw new StaffSignInRefusedError(
        'USER_DEACTIVATED',
        `sign-in refused: the profile of user ${user.id} was deleted`,
      );
    }
    const byId = existing;
    const byEmail = byId ?? (await this.directory.findByEmail(email));

    if (byEmail && byEmail.id !== user.id) {
      // identity created (or holds) a user with a different id than the profile of this address. Ids must match: every
      // foreign key in the product points at the profile id. The backfill (idempotent) creates the identity user WITH the
      // profile's id; re-run it, then the person signs in again.
      this.logger.error(
        { profileId: byEmail.id, identityUserId: user.id },
        'identity.profile_id_mismatch: sign-in refused',
      );
      throw new StaffSignInRefusedError(
        'PROFILE_ID_MISMATCH',
        `sign-in refused: the profile for this address is ${byEmail.id} but the identity user is ${user.id}`,
      );
    }
    if (byId && (byId.status === 'suspended' || byId.status === 'inactive')) {
      throw new StaffSignInRefusedError(
        'USER_DEACTIVATED',
        `sign-in refused: user ${user.id} is ${byId.status}`,
      );
    }

    const isPlatformAdmin = !claims.guest && this.platformAdmins().includes(email);
    const hasInvitation = await this.directory.hasLiveInvitation(workspaceId, email, claims.oid);
    // A guest is admitted by a live invitation or by a seat they STILL hold (an active workspace_members row), exactly as under v7's
    // invite-only shared gate: a profile alone is not a seat. A guest who was removed from the workspace keeps their profile (history
    // keeps its names) and must not be able to sign back in on it.
    const stillSeated = claims.guest && (await this.workspaces.getMemberships(user.id)).length > 0;
    const admitted = claims.guest
      ? hasInvitation || stillSeated
      : this.config.get('SSO_JIT_ENABLED') || isPlatformAdmin || byId !== null || hasInvitation;
    if (!admitted) {
      throw new StaffSignInRefusedError(
        claims.guest ? 'SSO_NO_ACCESS' : 'SSO_JIT_DISABLED',
        `sign-in refused: user ${user.id} has no seat, no profile and no live invitation`,
      );
    }

    if (!byId) {
      await this.directory.insertProfile({
        id: user.id,
        email,
        displayName: user.name || email,
        // The tenant vouches for a MEMBER's address; a guest's `email` claim is whatever the guest's own tenant says.
        emailVerified: !claims.guest,
      });
    }
    await this.workspaces.enrollMember(workspaceId, user.id);

    if (isPlatformAdmin) {
      const elevated = await this.access.elevateToWorkspaceAdmin(user.id, workspaceId);
      if (elevated) {
        await this.audit.record({
          workspaceId,
          actorId: user.id,
          actorEmail: email,
          action: 'access.role_elevated',
          resourceType: 'user',
          resourceId: user.id,
          metadata: { role: 'workspace_admin', via: 'PLATFORM_ADMIN_EMAILS', method: 'sso' },
        });
      }
    }
    await this.directory.touchLastLogin(user.id);
    await this.workspaces.touchMembership(user.id, workspaceId);
  }

  private platformAdmins(): string[] {
    return (this.config.get('PLATFORM_ADMIN_EMAILS') ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }
}

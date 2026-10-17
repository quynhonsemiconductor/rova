import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  clearContext,
  clearContextEverywhere,
  type Identity,
} from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import type { WorkspaceContextRevoker } from '@platform';

/** {@link WorkspaceContextRevoker} on identity's `clearContext` / `clearContextEverywhere`. Never throws. */
@Injectable()
export class IdentityContextRevoker implements WorkspaceContextRevoker {
  private readonly logger = new Logger(IdentityContextRevoker.name);

  constructor(@Inject(AUTH) private readonly auth: Identity) {}

  async clearForUser(userId: string, workspaceId: string): Promise<number> {
    try {
      return await clearContext(this.auth, { userId, contextId: workspaceId });
    } catch (err) {
      this.logger.warn({ err: (err as Error).name, userId, workspaceId }, 'clearContext failed');
      return 0;
    }
  }

  async clearForWorkspace(workspaceId: string): Promise<number> {
    try {
      return await clearContextEverywhere(this.auth, workspaceId);
    } catch (err) {
      this.logger.warn({ err: (err as Error).name, workspaceId }, 'clearContextEverywhere failed');
      return 0;
    }
  }
}

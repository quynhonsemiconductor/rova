import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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

  /**
   * Resolved at CALL time, not injected. `WorkspaceService` takes this revoker, and the identity instance is built from the
   * sign-in handler, which takes `WorkspaceService`: injecting `AUTH` here would close that circle, and Nest answers a
   * circle of async providers by never finishing `compile()`.
   */
  private get auth(): Identity {
    return this.moduleRef.get<Identity>(AUTH, { strict: false });
  }

  constructor(private readonly moduleRef: ModuleRef) {}

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

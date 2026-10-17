import { Injectable } from '@nestjs/common';
import { WorkspaceService } from '@modules/workspace';

/**
 * The two questions identity's `context` option asks about the session's active workspace (identity README, "The active
 * context of a session"). Authorization stays in rova's `PolicyGuard`, per request, from its own tables; identity only
 * keeps the VALUE honest.
 */
@Injectable()
export class WorkspaceContext {
  constructor(private readonly workspaces: WorkspaceService) {}

  /** May this user act in this workspace? An ACTIVE `workspace_members` row of a live workspace. */
  async isActiveMember(userId: string, workspaceId: string): Promise<boolean> {
    const member = await this.workspaces.getMembership(userId, workspaceId);
    return member?.status === 'active';
  }

  /** The workspace a new session starts in, and the one it falls back to: the member's most recently active. */
  async lastActiveFor(userId: string): Promise<string | null> {
    const memberships = await this.workspaces.getMemberships(userId);
    return memberships[0]?.workspaceId ?? null;
  }
}

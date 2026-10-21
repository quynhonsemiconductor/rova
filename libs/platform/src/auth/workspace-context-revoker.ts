/**
 * Takes a workspace away from live sessions NOW, rather than at the next membership re-check (identity re-asks
 * `workspace_members` at most once per `revalidateSeconds` per process). The workspace module calls it after a member is
 * suspended or removed and after a workspace is deleted; the identity module implements it with identity's
 * `clearContext` / `clearContextEverywhere`. Declared here so the workspace module keeps no dependency on identity; left
 * unbound (the worker), the callers skip it.
 *
 * Best-effort by contract: the permission cache was already dropped and the re-check ends the context within a minute
 * regardless, so an implementation must not throw into a request that has already committed.
 */
export interface WorkspaceContextRevoker {
  /** End `userId`'s active workspace on every session that holds `workspaceId`. Returns how many sessions held it. */
  clearForUser(userId: string, workspaceId: string): Promise<number>;
  /** End `workspaceId` as the active workspace of every session. Returns how many sessions held it. */
  clearForWorkspace(workspaceId: string): Promise<number>;
}

export const WORKSPACE_CONTEXT_REVOKER = Symbol('WORKSPACE_CONTEXT_REVOKER');

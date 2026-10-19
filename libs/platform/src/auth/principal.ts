/**
 * The authenticated principal on `request.user`.
 *
 * It is built from one of two things, and nothing else:
 *  - the identity 8 session (`SessionAuthGuard`): `sub` is the identity user id, which IS the profile id
 *    (`identity.users.id = identity."user".id`, kept equal by the sign-in hook and watched by the cutover runbook), so every
 *    `user.sub` in the codebase keeps meaning the same person;
 *  - an API token (`ApiTokenGuard`): `sub` is the token owner, `apiTokenId` names the credential.
 *
 * The name `JwtPayload` is kept on purpose: it is imported by a hundred files, and renaming it is a mechanical change
 * that does not belong in a security-sensitive diff. There is no JWT any more.
 */
export interface JwtPayload {
  /** The user id (= identity user id = `identity.users.id`). */
  sub: string;
  /**
   * The identity session id, or for an API token the token's own id (a token is not a login, so there is no session to
   * point at). For logs and audit.
   */
  sessionId: string;
  /** The active workspace: the session's `contextId` (identity `context`), or the token's workspace. `''` when none. */
  workspaceId: string;
  /**
   * Always empty, by design: `PolicyGuard` resolves permissions from the database on every request, and a snapshot
   * here would be the mint-time claim that was deliberately removed. Kept so the type stays what 100 files read.
   */
  permissions: string[];
  /** Set when the request was authenticated by an API token. Routes that manage credentials refuse such a request. */
  apiTokenId?: string;
  /**
   * An API token's narrowing: `PolicyGuard` intersects it with what the database grants. It can only subtract, so a token
   * can never exceed its owner. Absent or empty means no narrowing.
   */
  scopes?: readonly string[];
}

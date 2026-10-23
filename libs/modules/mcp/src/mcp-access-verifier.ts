/**
 * The MCP access adapter: verifies the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` carried
 * as a Bearer value) and maps its Entra `oid` to the rova identity user.
 *
 * STUB UNTIL app-platform ships the real verifier (`identity/access-jwt` subpath: JWKS fetch,
 * `iss`/`aud` pinned, RS256, `exp` + `nbf`, then the oid → user mapping). Until that release
 * lands, `MCP_ENABLED=true` boots the route with {@link UNCONFIGURED_MCP_ACCESS_VERIFIER}, which
 * answers every call 503 — the module is wired end to end, nothing is reachable.
 *
 * This interface is the ONLY MCP code that touches authentication. Everything downstream — the
 * principal context, the guard, the tools — already speaks identity user ids. Swapping the stub
 * for the real verifier changes nothing else.
 */
export interface McpAccessPrincipal {
  /** The rova identity user id the verified Access token's `oid` maps to. */
  userId: string;
}

export interface McpAccessVerifier {
  /**
   * Verifies the bearer value fully (signature, issuer, audience, window) and maps it to the
   * rova user. Returns `null` when anything fails to verify — the caller answers one uniform 401.
   */
  verify(bearer: string): Promise<McpAccessPrincipal | null>;
}

/** Thrown when the route was booted without a real verifier (MCP_ENABLED=true, adapter absent). */
export class McpAccessNotConfiguredError extends Error {
  constructor() {
    super(
      'MCP access verifier is not configured: waiting on the app-platform identity/access-jwt adapter',
    );
    this.name = 'McpAccessNotConfiguredError';
  }
}

export const UNCONFIGURED_MCP_ACCESS_VERIFIER: McpAccessVerifier = {
  verify: () => {
    throw new McpAccessNotConfiguredError();
  },
};

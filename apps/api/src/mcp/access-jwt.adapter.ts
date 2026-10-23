import { Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AccessJwtError,
  type AccessPrincipal,
  createAccessJwtVerifier,
  type AccessJwtVerifier,
} from '@quynhonsemiconductor/identity/access-jwt';
import type { DrizzleDB } from '@platform';
import { users as identityUsers } from '@db/schema/identity';
import { workspaceMembers } from '@db/schema/workspace';
import type { McpAccessPrincipal, McpAccessVerifier } from './access-verifier';

/**
 * The real MCP access adapter, on identity 8.5.0's `access-jwt` verifier (app-platform#300) —
 * the origin side of MCP-PLAN §5, as constrained by the P0 spike (2026-10-23):
 *
 *  - the token is verified FULLY and pinned: RS256 against the team JWKS, `iss` = the team
 *    domain, `aud` = the MCP Access application's AUD tag (config, never hardcoded), `exp`+`nbf`;
 *  - `exp` equals the Access GRANT SESSION (planned 24 h), so it is NOT a freshness signal:
 *    on EVERY request the employee is resolved from the token's `email` (case-insensitively)
 *    and refused unless the row is an ACTIVE employee — the same RBAC as the REST route the
 *    tool injects into decides everything else, per route, per call;
 *  - the Entra `oid` claim is absent today and is NOT required (`allowEmailFallback` on);
 *    if it arrives later it is returned on the principal and MAY be used, but the email stays
 *    the key;
 *  - an unknown or offboarded employee is a uniform 403 ({@link McpAccessDeniedError}), logged
 *    with the Access `sub` — never echoed, never distinguishing unknown from offboarded, and
 *    NEVER auto-provisioned from an MCP call.
 */
export class McpAccessDeniedError extends Error {
  constructor() {
    super('the Access token does not name an active employee');
    this.name = 'McpAccessDeniedError';
  }
}

/** The verifier's error codes that mean "bad token" (a 401); everything else is availability (a 5xx). */
const BAD_TOKEN_CODES: ReadonlySet<AccessJwtError['code']> = new Set([
  'malformed',
  'invalid_signature',
  'expired',
  'not_yet_valid',
  'bad_issuer',
  'bad_audience',
  'wrong_algorithm',
  'missing_principal',
]);

export interface McpAccessJwtAdapterOptions {
  db: DrizzleDB;
  /** The Access team domain as an origin (`https://<team>.cloudflareaccess.com`); `iss` must equal it. */
  teamDomain: string;
  /** The MCP Access application's AUD tag. */
  audience: string;
  logger?: Logger;
}

/**
 * Builds the adapter: identity's verifier for the cryptography, one DB read per request for the
 * person, one for their workspace. Verifier construction fails fast on a bad config.
 */
export function createMcpAccessJwtAdapter(opts: McpAccessJwtAdapterOptions): McpAccessVerifier {
  const logger = opts.logger ?? new Logger('McpAccessJwt');
  const accessJwt: AccessJwtVerifier = createAccessJwtVerifier({
    teamDomain: opts.teamDomain,
    audience: opts.audience,
    // The `oid` claim does not reach the origin today (spike gate (d) failed): fall back to the
    // token's IdP-verified email. The email is the mapping key regardless; if `oid` starts
    // arriving it is returned on the principal and MAY be used, but never required.
    allowEmailFallback: true,
  });

  return {
    async verify(bearer: string): Promise<McpAccessPrincipal | null> {
      let principal: AccessPrincipal;
      try {
        principal = await accessJwt.verify(bearer);
      } catch (err) {
        if (err instanceof AccessJwtError && !BAD_TOKEN_CODES.has(err.code)) {
          // jwks_unavailable: the team domain is unreachable — availability, not a bad token.
          throw err;
        }
        return null; // one uniform 401, whatever the reason the token is not ours
      }

      // NOT a freshness signal, `exp`: resolve the employee NOW, on every request.
      const email = principal.email?.toLowerCase();
      if (!email) return deny(logger, principal.sub, 'the token carries no email claim');
      const [employee] = await opts.db
        .select({ id: identityUsers.id })
        .from(identityUsers)
        .where(
          and(
            sql`lower(${identityUsers.email}) = ${email}`,
            isNull(identityUsers.deletedAt),
            eq(identityUsers.status, 'active'),
          ),
        )
        .limit(1);
      if (!employee) return deny(logger, principal.sub, `no active employee for ${email}`);

      // The workspace the MCP session is bound to: the person's active membership.
      const [membership] = await opts.db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, employee.id), eq(workspaceMembers.status, 'active')))
        .limit(1);
      if (!membership) return deny(logger, principal.sub, `employee ${email} has no workspace`);

      return { userId: employee.id, workspaceId: membership.workspaceId };
    },
  };
}

/** One uniform 403: logged with the Access `sub`, never distinguishing unknown from offboarded. */
function deny(logger: Logger, sub: string, why: string): never {
  logger.warn({ accessSub: sub }, `MCP access denied: ${why}`);
  throw new McpAccessDeniedError();
}

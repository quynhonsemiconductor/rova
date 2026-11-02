import { Logger } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  AccessJwtError,
  type AccessPrincipal,
  createAccessJwtVerifier,
  type AccessJwtVerifier,
} from '@quynhonsemiconductor/identity/access-jwt';
import type { DrizzleDB } from '@platform';
import { users as identityUsers } from '@db/schema/identity';
import { workspaceMembers, workspaces } from '@db/schema/workspace';
import type { McpAccessPrincipal, McpAccessVerifier } from './access-verifier';

/**
 * The real MCP access adapter, on identity 8.5.0's `access-jwt` verifier (app-platform#300) —
 * the origin side of MCP-PLAN §5, as constrained by the P0 spike (2026-10-23):
 *
 *  - the token is verified FULLY and pinned: RS256 against the team JWKS, `iss` = the team
 *    domain, `aud` = the MCP Access application's AUD tag (config, never hardcoded), `exp`+`nbf`;
 *  - `exp` equals the Access GRANT SESSION (planned 24 h), so it is NOT a freshness signal:
 *    on EVERY request the employee is resolved from the token's `email` (the same
 *    trim+lowercase normaliser as `UserDirectory.findByEmail`, hitting `uq_users_email`) and
 *    refused unless the row is an ACTIVE, email-VERIFIED employee — the same RBAC as the REST
 *    route the tool injects into decides everything else, per route, per call. `emailVerified`
 *    is the guest exclusion: a B2B guest's one-time-PIN address is not the person's Entra email;
 *  - exactly ONE active workspace membership must match — rova is single-workspace today, and
 *    ambiguity FAILS CLOSED (403), it does not pick one;
 *  - the Entra `oid` claim is absent today and is NOT required (`allowEmailFallback` on);
 *    if it arrives later it is returned on the principal and MAY be used, but the email stays
 *    the key;
 *  - an unknown or offboarded employee is a uniform 403 ({@link McpAccessDeniedError}), logged
 *    with the Access `sub` and a stable reason code — never the email, never distinguishing
 *    unknown from offboarded, and NEVER auto-provisioned from an MCP call.
 */
export class McpAccessDeniedError extends Error {
  constructor() {
    super('the Access token does not name an active employee');
    this.name = 'McpAccessDeniedError';
  }
}

/** Stable refusal reasons for the log (never the email, never unknown-vs-offboarded). */
type DenyReason = 'no_email_claim' | 'no_active_employee' | 'no_workspace' | 'ambiguous_workspace';

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
        // Inverted on purpose: ONLY jwks_unavailable is availability (rethrown → the route's 503).
        // Every other verifier error is a bad token → one uniform 401.
        if (err instanceof AccessJwtError && err.code === 'jwks_unavailable') throw err;
        return null;
      }

      // NOT a freshness signal, `exp`: resolve the employee NOW, on every request. The same
      // trim+lowercase normaliser as `UserDirectory.findByEmail`, so `uq_users_email` is hit.
      const email = principal.email?.trim().toLowerCase();
      if (!email) return deny(logger, principal.sub, 'no_email_claim');
      const [employee] = await opts.db
        .select({ id: identityUsers.id })
        .from(identityUsers)
        .where(
          and(
            eq(identityUsers.email, email),
            eq(identityUsers.status, 'active'),
            eq(identityUsers.emailVerified, true), // excludes B2B guests / unverified addresses
            isNull(identityUsers.deletedAt),
          ),
        )
        .limit(1);
      if (!employee) return deny(logger, principal.sub, 'no_active_employee');

      // The workspace the MCP session is bound to: exactly ONE active membership in an active
      // workspace. Deterministic order so the ambiguity check is about the DATA, not the plan.
      const matches = await opts.db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, employee.id),
            eq(workspaceMembers.status, 'active'),
            eq(workspaces.status, 'active'),
            isNull(workspaces.deletedAt),
          ),
        )
        .orderBy(
          asc(workspaceMembers.joinedAt),
          // the composite key's tail (uq_workspace_member is workspace_id + user_id): no ties
          asc(workspaceMembers.workspaceId),
          asc(workspaceMembers.userId),
        );
      if (matches.length === 0) return deny(logger, principal.sub, 'no_workspace');
      if (matches.length > 1) return deny(logger, principal.sub, 'ambiguous_workspace');

      return { userId: employee.id, workspaceId: matches[0].workspaceId };
    },
  };
}

/** One uniform 403: logged as `{ accessSub, reason }` — never the email, never a distinction. */
function deny(logger: Logger, sub: string, reason: DenyReason): never {
  logger.warn({ accessSub: sub, reason }, 'MCP access denied');
  throw new McpAccessDeniedError();
}

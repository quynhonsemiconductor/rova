import { Logger } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  AccessJwtError,
  type AccessPrincipal,
  createAccessJwtVerifier,
  type AccessJwtVerifier,
} from '@quynhonsemiconductor/identity/access-jwt';
import { isDuplicateKeyError, type DrizzleDB } from '@platform';
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
 *    unknown from offboarded, and NEVER auto-provisioned from an MCP call;
 *  - the account is bound to the FIRST verified Access `sub` it sees. An email can be
 *    reassigned, so a later token for the same email with a different Access identity is a
 *    403, not a new session for the old account. An administrator clears `access_subject`
 *    to rebind.
 */
export class McpAccessDeniedError extends Error {
  constructor() {
    super('the Access token does not name an active employee');
    this.name = 'McpAccessDeniedError';
  }
}

/** Stable refusal reasons for the log (never the email, never unknown-vs-offboarded). */
type DenyReason =
  | 'no_email_claim'
  | 'no_active_employee'
  | 'ambiguous_email'
  | 'access_subject_mismatch'
  | 'access_subject_taken'
  | 'no_workspace'
  | 'ambiguous_workspace';

export interface McpAccessJwtAdapterOptions {
  db: DrizzleDB;
  /** The Access team domain as an origin (`https://<team>.cloudflareaccess.com`); `iss` must equal it. */
  teamDomain: string;
  /** The MCP Access application's AUD tag. */
  audience: string;
  logger?: Logger;
}

interface EmployeeRow {
  id: string;
  status: string;
  emailVerified: boolean;
  accessSubject: string | null;
}

/**
 * Resolve one account by email, deterministically.
 *
 * The exact address runs first, so a normal lower-case row (and `uq_users_email`) wins even if a
 * case variant exists. Only a miss falls back to `lower(email)`; more than one match is an
 * ambiguous data state and is refused, never resolved by picking a row or by letting the ORM
 * throw on multiple results.
 */
async function findEmployee(
  db: DrizzleDB,
  email: string,
): Promise<EmployeeRow | 'ambiguous' | null> {
  const columns = {
    id: identityUsers.id,
    status: identityUsers.status,
    emailVerified: identityUsers.emailVerified,
    accessSubject: identityUsers.accessSubject,
  } as const;
  const [exact] = await db
    .select(columns)
    .from(identityUsers)
    .where(and(eq(identityUsers.email, email), isNull(identityUsers.deletedAt)))
    .limit(1);
  if (exact) return exact;

  const matches = await db
    .select(columns)
    .from(identityUsers)
    .where(and(sql`lower(${identityUsers.email}) = ${email}`, isNull(identityUsers.deletedAt)))
    .limit(2);
  if (matches.length > 1) return 'ambiguous';
  return matches[0] ?? null;
}

/**
 * Bind the first Access `sub` to this account, atomically.
 *
 * `WHERE access_subject IS NULL RETURNING id` makes concurrent first logins race to one winner.
 * A loser reads the persisted value: the same sub (another thread of the same person) is fine; a
 * different sub is a refusal. A unique violation means the sub is already bound to another user.
 */
export async function bindAccessSubject(
  db: DrizzleDB,
  userId: string,
  accessSubject: string,
): Promise<'bound' | 'same' | 'mismatch'> {
  const bound = await db
    .update(identityUsers)
    .set({ accessSubject })
    .where(and(eq(identityUsers.id, userId), isNull(identityUsers.accessSubject)))
    .returning({ id: identityUsers.id });
  if (bound.length > 0) return 'bound';

  const [current] = await db
    .select({ accessSubject: identityUsers.accessSubject })
    .from(identityUsers)
    .where(eq(identityUsers.id, userId))
    .limit(1);
  return current?.accessSubject === accessSubject ? 'same' : 'mismatch';
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
      const employee = await findEmployee(opts.db, email);
      if (employee === 'ambiguous') return deny(logger, principal.sub, 'ambiguous_email');
      if (
        !employee ||
        employee.status !== 'active' ||
        !employee.emailVerified // excludes B2B guests / unverified addresses
      ) {
        return deny(logger, principal.sub, 'no_active_employee');
      }

      // The bind happens ONLY after the workspace check (§ below): a request that is refused for
      // having no workspace must not leave a permanent subject on the account.

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

      // Bind the account to the FIRST verified Access sub only once every refusal above has
      // passed. A denied request (no workspace, ambiguous workspace) must not bind permanently.
      if (employee.accessSubject !== null) {
        if (employee.accessSubject !== principal.sub) {
          return deny(logger, principal.sub, 'access_subject_mismatch');
        }
      } else {
        try {
          const binding = await bindAccessSubject(opts.db, employee.id, principal.sub);
          if (binding === 'mismatch') {
            return deny(logger, principal.sub, 'access_subject_mismatch');
          }
        } catch (err) {
          // Drizzle WRAPS driver errors in DrizzleQueryError, so the pg code is on `.cause`;
          // @platform's recogniser walks the whole chain.
          if (isDuplicateKeyError(err)) {
            return deny(logger, principal.sub, 'access_subject_taken');
          }
          throw err;
        }
      }

      return { userId: employee.id, workspaceId: matches[0].workspaceId };
    },
  };
}

/** One uniform 403: logged as `{ accessSub, reason }` — never the email, never a distinction. */
function deny(logger: Logger, sub: string, reason: DenyReason): never {
  logger.warn({ accessSub: sub, reason }, 'MCP access denied');
  throw new McpAccessDeniedError();
}

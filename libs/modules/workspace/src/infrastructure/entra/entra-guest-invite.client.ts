/**
 * EntraGuestInviteClient — creates a Microsoft Entra B2B GUEST for an invited external
 * collaborator, so they can sign in with any real mailbox while Rova's own invitation stays the
 * authorization gate. Entra does the mailbox verification (their Microsoft work account, Google
 * federation, or an emailed one-time passcode); Rova never holds a credential for them.
 *
 * Flow, app-only (no user in the loop), on the "Rova <Env> Service" app's CERTIFICATE
 * (ONPREM-PLAN §7.3):
 *   1. Client-credentials token via `@azure/identity`'s `ClientCertificateCredential`, signing the
 *      client assertion with the key in the worker-only file `AZURE_CLIENT_CERTIFICATE_PATH` —
 *      the SAME credential the Graph mail transport reads; no client secret anywhere.
 *   2. POST https://graph.microsoft.com/v1.0/invitations, whose response carries `invitedUser.id`
 *      — the guest's `oid` in OUR tenant.
 *
 * The Service app needs the `User.Invite.All` APPLICATION permission with admin consent — hence
 * `ENTRA_GUEST_INVITE_ENABLED` defaulting to false. Unlike Exchange RBAC's `Mail.Send` (scoped to
 * one mailbox), `User.Invite.All` is TENANT-WIDE: accepted deliberately, because only the worker
 * ever holds the certificate and the sign-in app keeps no application permissions.
 *
 * Native `fetch`, deliberately: this repo has no HTTP client dependency and
 * `GithubAppAuthService` (the precedent for an app-only token cache) uses `fetch` too.
 */
import { ClientCertificateCredential, type TokenCredential } from '@azure/identity';
import { Injectable, Logger } from '@nestjs/common';
import {
  AppConfigService,
  ResilienceService,
  ResiliencePreset,
  RetryAfterError,
  retryAfterMsFrom,
} from '@platform';

/**
 * One execution of the Graph call — the token request AND the invitation — must finish inside this, and the
 * requests carry an `AbortSignal` for it. It equals `ResiliencePreset.EXTERNAL_API`'s per-execution timeout on
 * purpose: that timeout rejects the caller's promise but cannot stop a `fetch` already in flight, so without the
 * signal a POST that outlived it could still land on Graph after the relay's lease had lapsed and another worker
 * had taken the row. (An invitation is idempotent on Graph's side, but a late request is still a request nobody
 * is waiting for.)
 */
export const GRAPH_CALL_TIMEOUT_MS = 30_000;

/** Microsoft identity platform authority. Same host the bootstrap seed writes as the authority. */
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
/** App-only Graph scope — the `.default` form is what client-credentials requires. */
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

/**
 * A Graph refusal that CANNOT succeed on a retry: a malformed address, a tenant with B2B
 * invitations switched off, a missing `User.Invite.All` grant.
 *
 * A distinct class rather than a message convention, because the relay has to branch on it to
 * dead-letter the row instead of burning five attempts over fifteen minutes, and matching on
 * error prose breaks the day Microsoft rewords it.
 */
export class PermanentGuestInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentGuestInviteError';
  }
}

/**
 * The three outcomes that are NOT a transient fault.
 *
 * `already-in-directory` is a SUCCESS, not a refusal: the desired end state — this address can
 * authenticate against our tenant — already holds, and the ordinary way to reach it is inviting a
 * staff mailbox, which is a directory member already. Graph reports it as a `proxyAddresses`
 * collision with an existing directory object.
 */
export type GuestInviteOutcome =
  | { outcome: 'invited'; guestObjectId: string | null }
  | { outcome: 'already-in-directory'; detail: string };

export interface GuestInviteRequest {
  email: string;
  displayName?: string | null;
}

/** Shape of a Graph error body (`{ error: { code, message } }`). */
interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

interface GraphInvitationResponse {
  invitedUser?: { id?: string } | null;
}

/** The "Rova <Env> Service" app credentials: a certificate FILE, never a client secret. */
interface EntraServiceCredentials {
  tenantId: string;
  clientId: string;
  /** Path of the worker-only combined PEM (private key first, then the certificate). */
  certificatePath: string;
}

/** What a credential must do — `TokenCredential` narrowed to the one call this client makes. */
type AppTokenSource = Pick<TokenCredential, 'getToken'>;

/** Builds the Service app credential. Overridden only in tests; production is {@link defaultGuestCredentialFactory}. */
export type EntraGuestCredentialFactory = (c: EntraServiceCredentials) => AppTokenSource;

/** The production credential: the Service app's certificate from the worker-only file. */
export const defaultGuestCredentialFactory: EntraGuestCredentialFactory = (c) =>
  new ClientCertificateCredential(c.tenantId, c.clientId, { certificatePath: c.certificatePath });

@Injectable()
export class EntraGuestInviteClient {
  private readonly logger = new Logger(EntraGuestInviteClient.name);
  /** Built lazily on the first invite: reading the certificate file must not happen at boot. */
  private credential: AppTokenSource | null = null;

  /**
   * The credential factory is a FIELD, not a third constructor parameter: a constructor parameter
   * of bare function type is recorded as design:paramtypes `Function`, and Nest would try to
   * resolve `Function` at boot and fail the worker's module. Tests assign this field; the worker
   * registers the class as a PLAIN provider with only its two DI dependencies.
   */
  makeCredential: EntraGuestCredentialFactory = defaultGuestCredentialFactory;

  constructor(
    private readonly config: AppConfigService,
    private readonly resilience: ResilienceService,
  ) {}

  /**
   * True when the feature is on AND the Service app's certificate configuration is present.
   *
   * Both halves matter: the flag is the tenant-consent gate (`User.Invite.All`), and the
   * credential variables are mandatory for the worker to have been configured correctly.
   */
  isConfigured(): boolean {
    return (
      this.config.get('ENTRA_GUEST_INVITE_ENABLED') === true &&
      !!this.config.get('ENTRA_TENANT_ID') &&
      !!this.config.get('MAIL_GRAPH_CLIENT_ID') &&
      !!this.config.get('AZURE_CLIENT_CERTIFICATE_PATH')
    );
  }

  /**
   * Invite `email` as a B2B guest.
   *
   * Wrapped in `ResiliencePreset.EXTERNAL_API` (retry + breaker + timeout + bulkhead) — but ONLY
   * a transient fault throws out of the wrapped operation. A permanent refusal is returned through
   * the classification below instead, for two reasons: retrying a malformed address three times
   * achieves nothing, and — the one that actually bites — five consecutive permanent refusals
   * would trip the shared circuit breaker and block guest provisioning for every OTHER invitation
   * for a minute. `PermanentGuestInviteError` is therefore thrown OUTSIDE `execute`.
   */
  async invite(request: GuestInviteRequest): Promise<GuestInviteOutcome> {
    // Resolved BEFORE the resilience wrapper: a missing configuration is permanent, and throwing
    // it from inside `execute` would burn three retries and count three breaker failures for a
    // condition no retry can change.
    const credentials = this.requireServiceCredentials();

    const result = await this.resilience.execute(
      'entra.graph.createInvitation',
      () => this.postInvitation(request, credentials),
      ResiliencePreset.EXTERNAL_API,
    );

    if (result.kind === 'refused') throw new PermanentGuestInviteError(result.detail);
    // Thrown OUTSIDE `execute`, like a refusal, for the same reason: inside it the resilience layer would retry a
    // throttled call in milliseconds (and count it against the breaker) instead of honouring the server's wait.
    if (result.kind === 'throttled') throw new RetryAfterError(result.detail, result.retryAfterMs);
    return result.outcome;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private requireServiceCredentials(): EntraServiceCredentials {
    const tenantId = this.config.get('ENTRA_TENANT_ID');
    const clientId = this.config.get('MAIL_GRAPH_CLIENT_ID');
    const certificatePath = this.config.get('AZURE_CLIENT_CERTIFICATE_PATH');
    if (!tenantId || !clientId || !certificatePath) {
      throw new PermanentGuestInviteError(
        'Entra guest provisioning is enabled but ENTRA_TENANT_ID / MAIL_GRAPH_CLIENT_ID / ' +
          'AZURE_CLIENT_CERTIFICATE_PATH are not all set',
      );
    }
    return { tenantId, clientId, certificatePath };
  }

  private async postInvitation(
    request: GuestInviteRequest,
    credentials: EntraServiceCredentials,
  ): Promise<
    | { kind: 'ok'; outcome: GuestInviteOutcome }
    | { kind: 'refused'; detail: string }
    | { kind: 'throttled'; detail: string; retryAfterMs: number }
  > {
    // ONE deadline for the whole execution: the token request and the POST share it.
    const signal = AbortSignal.timeout(GRAPH_CALL_TIMEOUT_MS);
    const token = await this.getAppToken(credentials, signal);

    const res = await fetch(`${GRAPH_BASE_URL}/invitations`, {
      signal,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        invitedUserEmailAddress: request.email,
        /**
         * Where a guest who redeems the Entra invitation out of band lands. The SPA origin, not
         * the tokenized `/accept-invitation?token=…` link — the raw token exists only in the
         * invitation email; this relay holds nothing but its hash and could not reconstruct it.
         * Same `APP_BASE_URL` config `WorkspaceService.scheduleInviteEmail` builds `inviteUrl` from.
         */
        inviteRedirectUrl: this.config.get('APP_BASE_URL'),
        /**
         * Rova sends its own invitation email, carrying the token that is the actual
         * authorization gate — two emails would be two different calls to action for one
         * invitation. `false` is Graph's documented default; stated explicitly because a default
         * that changes silently would double-mail every invitee.
         */
        sendInvitationMessage: false,
        ...(request.displayName ? { invitedUserDisplayName: request.displayName } : {}),
      }),
    });

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as GraphInvitationResponse;
      return {
        kind: 'ok',
        outcome: { outcome: 'invited', guestObjectId: body.invitedUser?.id ?? null },
      };
    }

    const raw = await res.text().catch(() => '');
    const graphError = this.parseGraphError(raw);
    const detail = `Graph POST /invitations failed (${res.status})${
      graphError.code ? ` ${graphError.code}` : ''
    }: ${graphError.message || raw.slice(0, 300) || '(no body)'}`;

    /**
     * A collision with an existing directory object. Graph reports it as a `proxyAddresses`
     * conflict, and the population that reaches it is staff: an invitation to a `@qnsc.vn` mailbox
     * names a directory MEMBER, who needs no guest. Recorded as a success so it neither
     * dead-letters nor pages — the alarm on `outboxDeadLetter` exists for work that was LOST, and
     * nothing is lost here.
     */
    if (res.status === 400 && this.isDirectoryCollision(graphError.message ?? raw)) {
      return {
        kind: 'ok',
        outcome: {
          outcome: 'already-in-directory',
          detail: `No guest created — the address already resolves to a directory object. ${detail}`,
        },
      };
    }

    /**
     * Permanent by status. 4xx covers the refusals worth naming:
     *   400 — an address Graph will not accept. `+` and ~25 other characters are rejected outright,
     *         so a plus-addressed mailbox can never be invited and retrying is pointless.
     *   400/403 — B2B invitations disabled tenant-wide (`Authorization_RequestDenied`). App-only
     *         permission does NOT work through that switch, so no retry and no other credential
     *         will get past it.
     *   403 — the `User.Invite.All` application permission is missing or unconsented. This is what
     *         `ENTRA_GUEST_INVITE_ENABLED` exists to prevent; if it happens, dead-lettering is the
     *         signal, because retrying until an admin acts would just hide it.
     *   404/405/409/… — a contract change on our side. Never self-healing.
     *
     * 408 and 429 are excluded: those ARE transient, and 429 in particular must be retried.
     */
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      return { kind: 'refused', detail };
    }

    // 429 / 503 WITH a Retry-After: Graph told us how long to wait. Hand that to the relay (RetryAfterError, clamped
    // there) rather than retrying inside the resilience layer, which would hit the same throttle again in ms.
    if (res.status === 429 || res.status === 503) {
      const retryAfterMs = retryAfterMsFrom(res.headers);
      if (retryAfterMs !== undefined) return { kind: 'throttled', detail, retryAfterMs };
    }

    // 5xx, 429, 408 without a hint — throw so retry + circuit breaker + the outbox's own backoff all apply.
    throw new Error(detail);
  }

  /**
   * App-only access token from the Service app's certificate, via `@azure/identity`. The
   * credential is built once (it reads and parses the certificate file) and MSAL caches the
   * token internally, refreshing it inside its expiry window.
   *
   * Not wrapped in the resilience policy: it runs INSIDE the wrapped operation, so a token failure
   * already gets that call's retry and breaker accounting. Wrapping it separately would count one
   * outage twice.
   */
  private async getAppToken(
    credentials: EntraServiceCredentials,
    signal: AbortSignal,
  ): Promise<string> {
    this.credential ??= this.makeCredential(credentials);
    try {
      const result = await this.credential.getToken(GRAPH_DEFAULT_SCOPE, { abortSignal: signal });
      if (!result?.token) throw new Error('the credential returned no access_token');
      return result.token;
    } catch (err) {
      // Summarise, never echo: an MSAL failure can quote request URLs and assertion claims.
      const summary =
        err instanceof Error
          ? `${err.name}: ${err.message.split('\n')[0].slice(0, 300)}`
          : String(err);
      throw new Error(`Entra app-token request failed: ${summary}`, { cause: err });
    }
  }

  private parseGraphError(raw: string): { code?: string; message?: string } {
    try {
      const parsed = JSON.parse(raw) as GraphErrorBody;
      return { code: parsed.error?.code, message: parsed.error?.message };
    } catch {
      return {};
    }
  }

  /**
   * Graph's wording for "another directory object already owns this address". Matched on the
   * property name rather than a full sentence: `proxyAddresses` is a schema attribute name and
   * cannot be reworded the way surrounding prose can.
   */
  private isDirectoryCollision(message: string): boolean {
    const lowered = message.toLowerCase();
    return lowered.includes('proxyaddresses') || lowered.includes('already exists');
  }
}

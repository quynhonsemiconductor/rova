/**
 * EntraGuestInviteClient — the Graph half of B2B guest provisioning.
 *
 * What is worth pinning here is the CLASSIFICATION, not the happy path: which refusals are
 * permanent (so the relay dead-letters instead of burning five attempts over fifteen minutes),
 * which are transient (so retry and the circuit breaker apply), and which are not failures at all
 * (an address that already resolves to a directory object — the ordinary outcome for a staff
 * mailbox). Plus the request body, since a wrong `sendInvitationMessage` double-mails every
 * invitee, and the app-token cache, since one token per call would be a needless round-trip on
 * every row of a batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  EntraGuestInviteClient,
  GRAPH_CALL_TIMEOUT_MS,
  PermanentGuestInviteError,
} from './entra-guest-invite.client';
import { RESILIENCE_PRESETS, ResiliencePreset, RetryAfterError } from '@platform';
import { AppConfigService, ResilienceService } from '@platform';

const CONFIG: Record<string, unknown> = {
  ENTRA_GUEST_INVITE_ENABLED: true,
  ENTRA_TENANT_ID: 'tenant-1',
  MAIL_GRAPH_CLIENT_ID: 'service-app-1',
  AZURE_CLIENT_CERTIFICATE_PATH: '/mnt/secrets/rova-graph-cert.pem',
  APP_BASE_URL: 'https://rova.example',
};

function makeConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  const values = { ...CONFIG, ...overrides };
  return { get: vi.fn((key: string) => values[key]) } as unknown as AppConfigService;
}

/**
 * Pass-through resilience: the real service is `handleAll` retry + breaker + timeout, none of which
 * this file is testing. It DOES matter that a permanent refusal never reaches it — that is asserted
 * by the throw happening outside `execute`, which the pass-through preserves.
 */
function makeResilience(): ResilienceService {
  return {
    execute: vi.fn(<T>(_name: string, op: () => Promise<T>) => op()),
  } as unknown as ResilienceService;
}

/** A credential fake whose getToken always succeeds with `app-token`. */
function makeCredentialFake() {
  type GetTokenCall = [scope: string, options?: { abortSignal?: AbortSignal }];
  const getToken = vi.fn(async (..._args: GetTokenCall) => ({
    token: 'app-token',
    expiresOnTimestamp: Date.now() + 3_600_000,
  }));
  const factory = vi.fn((_c: unknown) => ({ getToken }));
  return { factory, getToken };
}

let credentials: ReturnType<typeof makeCredentialFake>;

const graphError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status });

/**
 * Every request body this client sends is a string (`URLSearchParams.toString()` or
 * `JSON.stringify`), but `RequestInit['body']` is the whole `BodyInit` union — so read it through
 * one narrowing helper rather than stringifying a union at four call sites.
 */
const bodyOf = (init: RequestInit): string => init.body as string;

/** The Nth fetch call as a [url, init] pair. */
const callAt = (mock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] =>
  mock.mock.calls[index] as [string, RequestInit];

describe('EntraGuestInviteClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  it('resolves in the Nest container exactly as the worker registers it (a PLAIN provider, two dependencies)', async () => {
    // The credential factory is a FIELD, deliberately not a third constructor parameter: a
    // constructor parameter of bare function type is recorded as design:paramtypes `Function`,
    // and Nest would try to resolve `Function` at boot and fail the worker's module. This
    // compiles the client exactly the way worker.module registers it, so a DI regression fails
    // HERE instead of the deploy.
    const moduleRef = await Test.createTestingModule({
      providers: [
        EntraGuestInviteClient,
        { provide: AppConfigService, useValue: makeConfig() },
        { provide: ResilienceService, useValue: makeResilience() },
      ],
    }).compile();
    expect(moduleRef.get(EntraGuestInviteClient).isConfigured()).toBe(true);
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    credentials = makeCredentialFake();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = (config = makeConfig()) => {
    const c = new EntraGuestInviteClient(config, makeResilience());
    c.makeCredential = credentials.factory;
    return c;
  };

  describe('isConfigured', () => {
    it('is false while the flag is off, even with every credential present', () => {
      expect(client(makeConfig({ ENTRA_GUEST_INVITE_ENABLED: false })).isConfigured()).toBe(false);
    });

    it('is false when the Service app credential configuration is incomplete', () => {
      expect(client(makeConfig({ MAIL_GRAPH_CLIENT_ID: undefined })).isConfigured()).toBe(false);
      expect(client(makeConfig({ AZURE_CLIENT_CERTIFICATE_PATH: undefined })).isConfigured()).toBe(
        false,
      );
    });

    it('is true with the flag on and the tenant, Service app id and certificate path set', () => {
      expect(client().isConfigured()).toBe(true);
    });
  });

  describe('invite — throttling', () => {
    it("hands a 429 with Retry-After to the relay as a RetryAfterError, with the server's wait", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
      );

      const err: unknown = await client()
        .invite({ email: 'dana@partner.example' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RetryAfterError);
      expect((err as RetryAfterError).retryAfterMs).toBe(120_000);
    });

    it('a 503 with Retry-After is the same; a 503 without one stays an ordinary retryable error', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{}', { status: 503, headers: { 'Retry-After': '10' } }),
      );
      expect(
        await client()
          .invite({ email: 'a@b.example' })
          .catch((e: unknown) => e),
      ).toBeInstanceOf(RetryAfterError);

      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
      const plain: unknown = await client()
        .invite({ email: 'a@b.example' })
        .catch((e: unknown) => e);
      expect(plain).toBeInstanceOf(Error);
      expect(plain).not.toBeInstanceOf(RetryAfterError);
    });
  });

  describe('invite — one deadline for the whole execution', () => {
    it('gives the token request and the invitation the SAME live AbortSignal', async () => {
      // The resilience timeout rejects the caller's promise but cannot stop a fetch already in flight; the
      // signal does, so a request that outlived the relay's lease is cancelled rather than landing late.
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ invitedUser: { id: 'g1' } }), { status: 201 }),
      );

      await client().invite({ email: 'dana@partner.example' });

      const tokenSignal = credentials.getToken.mock.calls[0][1]?.abortSignal as AbortSignal;
      const graphSignal = callAt(fetchMock, 0)[1].signal;
      expect(tokenSignal).toBeInstanceOf(AbortSignal);
      expect(graphSignal).toBe(tokenSignal);
      expect(tokenSignal?.aborted).toBe(false);
    });

    it('the deadline equals the resilience preset per-execution timeout, so the two cannot drift apart', () => {
      expect(GRAPH_CALL_TIMEOUT_MS).toBe(
        RESILIENCE_PRESETS[ResiliencePreset.EXTERNAL_API].timeout?.durationMs,
      );
    });
  });

  describe('invite — the Graph request', () => {
    it('posts the documented body and returns the guest object id', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ invitedUser: { id: 'guest-oid-1' } }), { status: 201 }),
      );

      const result = await client().invite({ email: 'dana@partner.example' });

      expect(result).toEqual({ outcome: 'invited', guestObjectId: 'guest-oid-1' });

      // The credential, not a hand-rolled token POST: the scope is app-only `.default`.
      expect(credentials.factory).toHaveBeenCalledTimes(1);
      expect(credentials.factory).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        clientId: 'service-app-1',
        certificatePath: '/mnt/secrets/rova-graph-cert.pem',
      });
      expect(credentials.getToken.mock.calls[0][0]).toBe('https://graph.microsoft.com/.default');

      // The ONLY network call this client makes itself: the invitation.
      const [graphUrl, graphInit] = callAt(fetchMock, 0);
      expect(graphUrl).toBe('https://graph.microsoft.com/v1.0/invitations');
      expect(graphInit.method).toBe('POST');
      expect(JSON.parse(bodyOf(graphInit))).toEqual({
        invitedUserEmailAddress: 'dana@partner.example',
        // The SPA origin, not the tokenized accept link: this relay holds only the token's hash.
        inviteRedirectUrl: 'https://rova.example',
        // Rally sends its own invitation email — two would be two calls to action for one invite.
        sendInvitationMessage: false,
      });
      expect((graphInit.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer app-token',
      );
    });

    it('includes invitedUserDisplayName only when there is one', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ invitedUser: { id: 'guest-oid-1' } }), { status: 201 }),
      );

      await client().invite({ email: 'dana@partner.example', displayName: 'Dana Partner' });

      const body = JSON.parse(bodyOf(callAt(fetchMock, 0)[1])) as Record<string, unknown>;
      expect(body.invitedUserDisplayName).toBe('Dana Partner');
    });

    it('tolerates a success body with no invitedUser', async () => {
      // The row is still `sent` — the guest exists; we simply have no oid to record, which the
      // nullable column already expresses.
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));

      await expect(client().invite({ email: 'dana@partner.example' })).resolves.toEqual({
        outcome: 'invited',
        guestObjectId: null,
      });
    });

    it('builds the credential ONCE and reuses it across calls', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));

      const c = client();
      await c.invite({ email: 'a@partner.example' });
      await c.invite({ email: 'b@partner.example' });

      // Reading and parsing the certificate file happens in the factory; MSAL then caches and
      // refreshes the token inside its own expiry window.
      expect(credentials.factory).toHaveBeenCalledTimes(1);
      expect(credentials.getToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('invite — refusals that are PERMANENT', () => {
    it('an address Graph will not accept (invalid characters, e.g. `+`)', async () => {
      // ~25 characters are rejected outright, so no retry can ever succeed for that mailbox.
      fetchMock.mockResolvedValueOnce(
        graphError(
          400,
          'Request_BadRequest',
          "Invalid value specified for property 'invitedUserEmailAddress' of resource 'Invitation'.",
        ),
      );

      await expect(client().invite({ email: 'a+b@partner.example' })).rejects.toBeInstanceOf(
        PermanentGuestInviteError,
      );
    });

    it('B2B invitations disabled tenant-wide — app-only permission does not bypass it', async () => {
      fetchMock.mockResolvedValueOnce(
        graphError(
          403,
          'Authorization_RequestDenied',
          'Guest invitations are not allowed for this tenant.',
        ),
      );

      await expect(client().invite({ email: 'dana@partner.example' })).rejects.toMatchObject({
        name: 'PermanentGuestInviteError',
        // The refusal reaches `last_error` legibly, code and message intact.
        message: expect.stringContaining('Authorization_RequestDenied'),
      });
    });

    it('a missing User.Invite.All grant (403) — what the feature flag exists to avoid', async () => {
      fetchMock.mockResolvedValueOnce(
        graphError(403, 'Authorization_RequestDenied', 'Insufficient privileges.'),
      );

      await expect(client().invite({ email: 'dana@partner.example' })).rejects.toBeInstanceOf(
        PermanentGuestInviteError,
      );
    });

    it('credentials that are not all configured, WITHOUT reaching the network', async () => {
      // Resolved before the resilience wrapper, so it cannot burn three retries or count three
      // breaker failures for a condition no retry changes.
      await expect(
        client(makeConfig({ AZURE_CLIENT_CERTIFICATE_PATH: undefined })).invite({
          email: 'dana@partner.example',
        }),
      ).rejects.toBeInstanceOf(PermanentGuestInviteError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('invite — a directory collision is a SUCCESS, not a refusal', () => {
    it('reports already-in-directory for a proxyAddresses conflict', async () => {
      // The population that reaches this is staff: a `@qnsc.vn` invitation names a directory MEMBER
      // who needs no guest. Dead-lettering it would page the `outboxDeadLetter` alarm for work that
      // was never lost.
      fetchMock.mockResolvedValueOnce(
        graphError(
          400,
          'Request_BadRequest',
          'Another object with the same value for property proxyAddresses already exists.',
        ),
      );

      const result = await client().invite({ email: 'staff@qnsc.vn' });

      expect(result.outcome).toBe('already-in-directory');
      expect(result).toMatchObject({ detail: expect.stringContaining('proxyAddresses') });
    });
  });

  describe('invite — faults that are TRANSIENT', () => {
    it.each([
      ['500 Graph outage', 500],
      ['429 throttling', 429],
      ['408 timeout', 408],
    ])('%s throws a plain Error, keeping the full retry budget', async (_label, status) => {
      fetchMock.mockResolvedValueOnce(
        graphError(status, 'serviceNotAvailable', 'Try again later.'),
      );

      const err = await client()
        .invite({ email: 'dana@partner.example' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentGuestInviteError);
    });

    it('a failed token acquisition stays a TRANSIENT error and names the failure, not the material', async () => {
      credentials.getToken.mockRejectedValueOnce(
        Object.assign(new Error('unauthorized: client assertion'), {
          name: 'CredentialUnavailableError',
        }),
      );
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));

      const err = await client()
        .invite({ email: 'dana@partner.example' })
        .catch((e: unknown) => e);

      expect((err as Error).message).toContain('Entra app-token request failed');
      expect((err as Error).message).toContain('CredentialUnavailableError');
      expect((err as Error).message).not.toContain('graph-cert.pem');
      // Transient by classification: a rotated certificate or an Entra blip both resolve on retry.
      expect(err).not.toBeInstanceOf(PermanentGuestInviteError);
    });
  });
});

/**
 * The Microsoft sign-in, end to end, against identity's mock Entra, plus the workspace context of the session.
 *
 * Every other e2e spec signs in through `/api/auth/test-login`, which finds the user and mints a session: it skips the
 * Microsoft flow, and with it the one hook that carries rova's product behaviour, `hooks.onStaffSignIn` (admission,
 * the profile row, the workspace seat, platform-admin elevation). This spec runs the real flow (authorize, PKCE, token
 * exchange, id_token checks, user linking, the hook, the session) with the same `createRovaIdentity` factory the API uses,
 * then presents the resulting cookie to the REAL API (`bootstrapApp`, so the CSRF hook and the request context are live).
 *
 * What it proves, and what it cannot:
 *  - a staff address is provisioned (JIT on) or refused (invite-only), and the profile it gets has the SAME id as the
 *    identity user: the decision that keeps every foreign key in the product valid;
 *  - a profile whose id differs from the identity user's (a repair the cutover backfill prevents) is refused, and the user
 *    this sign-in created is removed again;
 *  - a B2B guest (a vendor) is admitted only with a live invitation (by address) or an existing profile, never by JIT;
 *  - a platform admin is elevated to workspace admin;
 *  - the session starts in the member's workspace, `POST /v1/auth/switch-workspace` moves it (members only), and removing
 *    the member takes the workspace away at once;
 *  - another tenant, an address outside the staff domain and a banned user get no session.
 *  Not provable here: Entra's own behaviour (the single-tenant app registration, the `email` optional claim, the real
 *  redirect URI registration). Those are the manual checks in docs/runbooks/identity-v8-cutover.md.
 *
 * A second `Identity` instance built over the app's own database, cache and secret: the cookie it signs is accepted by the
 * API's instance because both derive from the same `BETTER_AUTH_SECRET`.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUserBanned, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  TestClient,
  startMockIdp,
  type IdpIdentity,
  type MockIdp,
} from '@quynhonsemiconductor/identity/testing';
import {
  AppConfigService,
  CSRF_SECRET_COOKIE,
  DRIZZLE,
  SESSION_COOKIE,
  type DrizzleDB,
} from '@platform';
import { AccessService } from '@modules/access';
import { AuditService } from '@modules/audit';
import { UserDirectory } from '@modules/identity';
import { WorkspaceService } from '@modules/workspace';
import { user as identityUser } from '../../db/schema/identity-auth';
import { users } from '../../db/schema/identity';
import { workspaceInvitations, workspaceMembers, workspaces } from '../../db/schema/workspace';
import { ADMIN_USER_ID, WORKSPACE_ID } from '../../db/seeds/constants';
import { createRovaIdentity } from '../../libs/modules/identity/src/infrastructure/auth/create-rova-identity';
import { SecurityEventAuditSink } from '../../libs/modules/identity/src/infrastructure/auth/security-events.audit';
import { StaffSignInHandler } from '../../libs/modules/identity/src/infrastructure/auth/staff-sign-in.handler';
import { WorkspaceContext } from '../../libs/modules/identity/src/infrastructure/auth/workspace-context';
import { createBootstrappedApp, readCookie } from './support/session';

const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const RUN = Date.now().toString(36).slice(-6);

let app: NestFastifyApplication;
let db: DrizzleDB;
let idp: MockIdp;
let appUrl: string;
let seq = 0;

/** What the sign-in hook reads from configuration, per scenario. */
const policy = { jit: true, platformAdmins: '' };

let identity: Identity;

/** A fresh Microsoft identity; staff by default, a B2B guest with `{ acct: 1 }`. */
function person(over: Partial<IdpIdentity> = {}, guest = false): IdpIdentity {
  const n = ++seq;
  return {
    sub: `idp-sub-${RUN}-${n}`,
    // a real uuid: the invitations table has a uuid column for the directory object
    oid: randomUUID(),
    tid: TENANT,
    email: `signin.${RUN}.${n}@qnsc.vn`,
    name: `Sign In ${n}`,
    ...(guest ? { claims: { roles: [], acct: 1 } } : {}),
    ...over,
  };
}

/**
 * Sign in through the mock Entra, every hop visible. Returns the `cookie` header (undefined if refused), the callback's
 * status, and the `error` code identity redirected the browser with (undefined on success).
 */
async function microsoftSignIn(
  who: IdpIdentity,
): Promise<{ cookie?: string; status: number; error?: string }> {
  idp.loginAs(who);
  const client = new TestClient(appUrl, identity.handler, { origin: appUrl });
  const start = await client.post('/api/auth/sign-in/social', {
    provider: 'microsoft',
    callbackURL: '/',
  });
  expect(start.status, start.body).toBe(200);
  const authz = await client.get(start.json<{ url: string }>().url);
  const callback = await client.get(authz.location ?? '');
  const value = client.cookies[SESSION_COOKIE];
  const error = callback.location
    ? (new URL(callback.location, appUrl).searchParams.get('error') ?? undefined)
    : undefined;
  return {
    status: callback.status,
    ...(error ? { error } : {}),
    ...(value ? { cookie: `${SESSION_COOKIE}=${value}` } : {}),
  };
}

interface Me {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  memberships: Array<{ workspaceId: string }>;
  csrfToken?: string;
}

async function me(cookie: string) {
  const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  return { status: res.statusCode, body: res.json<Me>(), headers: res.headers };
}

async function contextOf(cookie: string): Promise<string | null> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/get-session',
    headers: { cookie },
  });
  return res.json<{ session: { contextId: string | null } }>().session.contextId;
}

async function liveInvitation(email: string): Promise<void> {
  await db.insert(workspaceInvitations).values({
    workspaceId: WORKSPACE_ID,
    email,
    tokenHash: randomBytes(32).toString('hex'),
    invitedBy: ADMIN_USER_ID,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

beforeAll(async () => {
  app = await createBootstrappedApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  const real = app.get(AppConfigService);
  appUrl = real.get('APP_BASE_URL');
  idp = await startMockIdp();

  // The config the hook and the factory read: the real one, with the tenant pointed at the mock and the two knobs a
  // scenario turns (JIT, platform admins) read live.
  const config = {
    get: (key: string) => {
      switch (key) {
        case 'ENTRA_TENANT_ID':
          return TENANT;
        case 'ENTRA_CLIENT_ID':
          return 'e2e-client';
        case 'ENTRA_CLIENT_SECRET':
          return 'e2e-secret';
        case 'SSO_JIT_ENABLED':
          return policy.jit;
        case 'PLATFORM_ADMIN_EMAILS':
          return policy.platformAdmins;
        default:
          return (real.get as (k: string) => unknown)(key);
      }
    },
  } as unknown as AppConfigService;

  const staffSignIn = new StaffSignInHandler(
    app.get(UserDirectory),
    app.get(WorkspaceService),
    app.get(AccessService),
    app.get(AuditService),
    config,
  );
  identity = createRovaIdentity({
    config,
    db,
    cache: app.get(CacheService, { strict: false }),
    staffSignIn,
    workspaceContext: app.get(WorkspaceContext, { strict: false }),
    auditSink: app.get(SecurityEventAuditSink, { strict: false }),
    staffAuthority: idp.base,
  });
}, 60_000);

afterAll(async () => {
  await idp?.stop();
  await app?.close();
});

describe('Microsoft sign-in with the staff preset', () => {
  it('JIT on: provisions a staff address with profile.id = identity user id, a seat in the home workspace and a session in it', async () => {
    policy.jit = true;
    const who = person();

    const { cookie } = await microsoftSignIn(who);

    expect(cookie, 'the sign-in minted no session').toBeDefined();
    const principal = await me(cookie!);
    expect(principal.status).toBe(200);
    const [profile] = await db.select().from(users).where(eq(users.email, who.email!));
    const [v8] = await db.select().from(identityUser).where(eq(identityUser.email, who.email!));
    expect(profile, 'no profile row was created').toBeDefined();
    expect(profile.id).toBe(v8.id);
    expect(principal.body.id).toBe(v8.id);
    expect(principal.body.memberships.map((m) => m.workspaceId)).toEqual([WORKSPACE_ID]);
    // the session starts in the member's workspace (identity `context.initial`)
    expect(await contextOf(cookie!)).toBe(WORKSPACE_ID);
  });

  it('JIT off: refuses an unknown staff address, and leaves no row for the person it refused', async () => {
    policy.jit = false;
    const who = person();

    const refused = await microsoftSignIn(who);

    expect(refused.cookie, 'an unknown person was given a session with JIT off').toBeUndefined();
    expect(refused.status).toBe(302);
    expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
    expect(await db.select().from(users).where(eq(users.email, who.email!))).toHaveLength(0);
    expect(
      await db.select().from(identityUser).where(eq(identityUser.email, who.email!)),
    ).toHaveLength(0);
  });

  it('JIT off: admits a staff address that already has a profile (the cutover backfill created it, with the same id)', async () => {
    policy.jit = false;
    const who = person();
    const id = randomUUID();
    await app
      .get(UserDirectory)
      .insertProfile({ id, email: who.email!, displayName: 'Backfilled' });
    await db
      .insert(identityUser)
      .values({ id, name: 'Backfilled', email: who.email!, emailVerified: true });

    const { cookie, error } = await microsoftSignIn(who);

    expect(error).toBeUndefined();
    expect((await me(cookie!)).body.id, 'the session subject is the backfilled id').toBe(id);
  });

  it('refuses a profile whose id differs from the identity user (ids must match), and removes the user it created', async () => {
    policy.jit = false;
    const who = person();
    await app
      .get(UserDirectory)
      .insertProfile({ id: randomUUID(), email: who.email!, displayName: 'Orphan profile' });

    const refused = await microsoftSignIn(who);

    expect(refused.cookie).toBeUndefined();
    expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
    expect(
      await db.select().from(identityUser).where(eq(identityUser.email, who.email!)),
    ).toHaveLength(0);
  });

  it('elevates a platform admin to workspace admin', async () => {
    policy.jit = true;
    const who = person();
    policy.platformAdmins = `other@qnsc.vn, ${who.email!.toUpperCase()}`;
    try {
      const { cookie } = await microsoftSignIn(who);
      const principal = await me(cookie!);
      expect(principal.body.role).toBe('workspace_admin');
    } finally {
      policy.platformAdmins = '';
    }
  });

  it('refuses another tenant, and an address outside the staff domain: no session', async () => {
    policy.jit = true;
    const foreign = await microsoftSignIn(person({ tid: OTHER_TENANT }));
    expect(foreign.cookie, 'a foreign tenant was given a session').toBeUndefined();
    expect(foreign.error).toBe('unable_to_get_user_info');

    const outsider = await microsoftSignIn(person({ email: `outsider.${RUN}@example.com` }));
    expect(outsider.cookie, 'an address off the staff domain was given a session').toBeUndefined();
    expect(outsider.error).toBe('unable_to_get_user_info');
  });

  it('refuses a banned user, even though Entra still lets them in', async () => {
    policy.jit = true;
    const who = person();
    const first = await microsoftSignIn(who);
    const { id } = (await me(first.cookie!)).body;

    await setUserBanned(app.get<Identity>(AUTH), id, true, 'e2e: offboarded');
    const refused = await microsoftSignIn(who);

    expect(refused.cookie, 'a banned user was given a session').toBeUndefined();
    expect(refused.error).toBe('BANNED_USER');
    await setUserBanned(app.get<Identity>(AUTH), id, false);
  });
});

describe('B2B guests (vendors)', () => {
  it('refuses a guest with no profile and no invitation, even with JIT on', async () => {
    policy.jit = true;
    const refused = await microsoftSignIn(
      person({ email: `vendor.${RUN}.a@vendor.example` }, true),
    );

    expect(refused.cookie, 'a guest was JIT-provisioned').toBeUndefined();
    expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
  });

  it('admits a guest who holds a live invitation (by address), and seats them in the workspace', async () => {
    policy.jit = false;
    const who = person({ email: `vendor.${RUN}.b@vendor.example` }, true);
    await liveInvitation(who.email!);

    const { cookie, error } = await microsoftSignIn(who);

    expect(error).toBeUndefined();
    const principal = await me(cookie!);
    expect(principal.status).toBe(200);
    expect(principal.body.memberships.map((m) => m.workspaceId)).toEqual([WORKSPACE_ID]);
    // a guest holds no project access until a workspace admin grants some: no permissions, but a valid session
    expect(principal.body.permissions).toEqual([]);
  });

  it('refuses a guest whose invitation expired', async () => {
    policy.jit = false;
    const who = person({ email: `vendor.${RUN}.c@vendor.example` }, true);
    await db.insert(workspaceInvitations).values({
      workspaceId: WORKSPACE_ID,
      email: who.email!,
      tokenHash: randomBytes(32).toString('hex'),
      invitedBy: ADMIN_USER_ID,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const refused = await microsoftSignIn(who);

    expect(refused.cookie).toBeUndefined();
    expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
  });
});

describe('guests (vendors): who may come back, and whose invitation it is', () => {
  it('refuses a guest who was removed from the workspace: a profile is not a seat', async () => {
    policy.jit = false;
    const who = person({ email: `vendor.${RUN}.d@vendor.example` }, true);
    await liveInvitation(who.email!);
    const first = await microsoftSignIn(who);
    expect(first.cookie, 'the invited guest signs in').toBeDefined();
    const { id } = (await me(first.cookie!)).body;
    // the invitation is spent and the guest is removed (v7: the invite-only gate required an active workspace_members row)
    await db
      .update(workspaceInvitations)
      .set({ status: 'cancelled' })
      .where(eq(workspaceInvitations.email, who.email!));
    await app.get(WorkspaceService).removeMember(WORKSPACE_ID, id, ADMIN_USER_ID);

    const again = await microsoftSignIn(who);

    expect(again.cookie, 'a removed guest got back in on their profile').toBeUndefined();
    expect(again.error).toBe('STAFF_SIGN_IN_REFUSED');
  });

  it('binds an invitation made for a directory object to that object only: a spoofed email claim neither squats it nor locks the invitee out', async () => {
    policy.jit = false;
    const invitee = person({ email: `vendor.${RUN}.e@vendor.example` }, true);
    await db.insert(workspaceInvitations).values({
      workspaceId: WORKSPACE_ID,
      email: invitee.email!,
      tokenHash: randomBytes(32).toString('hex'),
      invitedBy: ADMIN_USER_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
      entraGuestObjectId: invitee.oid!,
    });

    // someone else, whose tenant lets them choose the `mail` claim, presents the invitee's address
    const squatter = await microsoftSignIn({ ...person({}, true), email: invitee.email! });
    expect(squatter.cookie, 'a spoofed address took the invitation').toBeUndefined();
    expect(squatter.error).toBe('STAFF_SIGN_IN_REFUSED');

    // the real invitee still gets in (by their object id), and nothing was squatted
    const real = await microsoftSignIn(invitee);
    expect(real.error).toBeUndefined();
    expect((await me(real.cookie!)).status).toBe(200);
  });

  it('lets a guest accept an invitation bound to their directory object (the v8 account is what proves it)', async () => {
    policy.jit = false;
    const guest = person({ email: `vendor.${RUN}.f@vendor.example` }, true);
    const raw = randomBytes(32).toString('base64url');
    await db.insert(workspaceInvitations).values({
      workspaceId: WORKSPACE_ID,
      email: guest.email!,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      invitedBy: ADMIN_USER_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
      entraGuestObjectId: guest.oid!,
    });
    const { cookie } = await microsoftSignIn(guest);
    const { id } = (await me(cookie!)).body;

    // before the fix this read the v7 sso_identities, which a v8 sign-in never writes: INVITATION_EMAIL_MISMATCH
    await expect(app.get(WorkspaceService).acceptInvitation(raw, id)).resolves.toBeUndefined();
  });

  it("records a guest profile as email-unverified (the claim is their own tenant's), a staff one as verified", async () => {
    policy.jit = false;
    const guest = person({ email: `vendor.${RUN}.g@vendor.example` }, true);
    await liveInvitation(guest.email!);
    await microsoftSignIn(guest);
    policy.jit = true;
    const staff = person();
    await microsoftSignIn(staff);

    const [g] = await db.select().from(users).where(eq(users.email, guest.email!));
    const [m] = await db.select().from(users).where(eq(users.email, staff.email!));
    expect(g.emailVerified).toBe(false);
    expect(m.emailVerified).toBe(true);
  });
});

describe('profiles, sessions and the session body', () => {
  it('refuses a person whose profile was soft-deleted, instead of creating a session on it', async () => {
    policy.jit = true;
    const who = person();
    const first = await microsoftSignIn(who);
    const { id } = (await me(first.cookie!)).body;
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));

    const again = await microsoftSignIn(who);

    expect(again.cookie).toBeUndefined();
    expect(again.error).toBe('STAFF_SIGN_IN_REFUSED');
  });

  it('answers /v1/auth/me for a session with no workspace: no role, no permissions, no 500', async () => {
    policy.jit = true;
    const { cookie } = await microsoftSignIn(person());
    const { id } = (await me(cookie!)).body;
    await app.get(WorkspaceService).removeMember(WORKSPACE_ID, id, ADMIN_USER_ID);
    expect(await contextOf(cookie!)).toBeNull();

    const principal = await me(cookie!);

    expect(principal.status).toBe(200);
    expect(principal.body).toMatchObject({ role: '', permissions: [], memberships: [] });
  });

  it('keeps the raw session token out of get-session and list-sessions', async () => {
    policy.jit = true;
    const { cookie } = await microsoftSignIn(person());
    for (const url of ['/api/auth/get-session', '/api/auth/list-sessions']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toMatch(/"token"/);
      expect(res.body, url).toContain('"expiresAt"');
    }
  });
});

describe('the active workspace of the session', () => {
  async function csrf(cookie: string): Promise<{ cookie: string; token: string }> {
    const res = await me(cookie);
    const secret = readCookie(res.headers['set-cookie'], CSRF_SECRET_COOKIE);
    expect(secret, 'the CSRF secret cookie').toBeDefined();
    return { cookie: `${cookie}; ${secret!}`, token: res.body.csrfToken! };
  }

  async function secondWorkspace(): Promise<string> {
    const [row] = await db
      .insert(workspaces)
      .values({ slug: `ctx-${RUN}-${++seq}`, name: 'Second workspace' })
      .returning({ id: workspaces.id });
    return row.id;
  }

  it('switches to another workspace the user belongs to, refuses one they do not, and loses one they are removed from', async () => {
    policy.jit = true;
    const { cookie: session } = await microsoftSignIn(person());
    const { body } = await me(session!);
    const second = await secondWorkspace();
    await app.get(WorkspaceService).enrollMember(second, body.id);
    const stranger = await secondWorkspace(); // a workspace they are NOT in

    const { cookie, token } = await csrf(session!);
    const post = (workspaceId: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/switch-workspace',
        headers: { cookie, 'x-csrf-token': token, ...headers },
        payload: { workspaceId },
      });

    // a member: switched, and the session now holds it
    expect((await post(second)).statusCode).toBe(204);
    expect(await contextOf(session!)).toBe(second);

    // not a member: 403 CONTEXT_FORBIDDEN, and nothing changes
    const refused = await post(stranger);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await contextOf(session!)).toBe(second);

    // the CSRF gate applies to the switch (it is a cookie-authenticated POST on rova's own route)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/switch-workspace',
          headers: { cookie },
          payload: { workspaceId: WORKSPACE_ID },
        })
      ).statusCode,
    ).toBe(403);

    // removed from the workspace: the session stops holding it NOW, not at the next re-check
    await db
      .update(workspaceMembers)
      .set({ status: 'removed' })
      .where(and(eq(workspaceMembers.workspaceId, second), eq(workspaceMembers.userId, body.id)));
    await app
      .get(WorkspaceService)
      .removeMember(second, body.id, ADMIN_USER_ID)
      .catch(() => undefined);
    expect(await contextOf(session!)).not.toBe(second);
  });

  it('does not let a session back into a workspace that was deleted, and drops it from the switcher', async () => {
    policy.jit = true;
    const { cookie: session } = await microsoftSignIn(person());
    const { body } = await me(session!);
    const doomed = await secondWorkspace();
    await app.get(WorkspaceService).enrollMember(doomed, body.id);
    const { cookie, token } = await csrf(session!);
    const post = (workspaceId: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/switch-workspace',
        headers: { cookie, 'x-csrf-token': token },
        payload: { workspaceId },
      });
    expect((await post(doomed)).statusCode).toBe(204);

    // deleted by someone other than this service (a soft delete straight on the row, as a repair or a script would)
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, doomed));

    const back = await post(doomed);
    expect(back.statusCode, back.body).toBe(403);
    expect((await me(session!)).body.memberships.map((m) => m.workspaceId)).not.toContain(doomed);
  });
});

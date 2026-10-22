# Multi-IdP OIDC Auth Broker — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes. **Every code step is TDD: write the failing test first, then the impl.**

> ## ⚠️ Status & revisions (2026-07-24) — read before executing
> **Package tasks T1–T9 are DONE** on branch `feat/multi-idp-oidc-broker` (stacked on `feat/identity-invite-break-glass`), all green (163 tests). The following override the task text below:
> - **Secret store = AWS Secrets Manager, NOT SSM.** Ignore the `AWS SSM` / `@aws-sdk/client-ssm` / `SsmSecretResolver` / `@quynhonsemiconductor/identity/ssm` mentions. The package ships only the `SecretResolver` **port** (done, store-agnostic). **Rova (T9-app) implements `SecretsManagerSecretResolver`.** Secrets under `rally/${env}/sso/*`.
> - **NEW IaC task (Terraform, `qnsc-tf-modules` + Rova live):** add a **task-role** policy `secretsmanager:GetSecretValue` on `rally/${env}/sso/*` + `kms:Decrypt` on the shared CMK (today only the *execution* role reads secrets, for boot-time env injection — the broker reads at **runtime**). Verify CMK key policy + runtime egress (VPC endpoint/NAT). Values set out-of-band. Rotation = separate hygiene follow-up.
> - **SSO-identity: NO schema change.** Skip **T11's `sso_identities` re-key** and **T12's user-repo re-key** — `sso_identities` keeps `(provider, provider_sub)`; the broker keys by `connection.provider`. `upsertBySsoIdentity/findSsoIdentity` signatures are unchanged.
> - **Registry has no cache** (instant cutoff), **one shared `assertConnectionAllows` gate**, and all broker code lives under `packages/identity/src/oidc/`.
> - **Legacy retained** (opshub depends on it; broker deps `@Optional`). Retire Rova's home route at T18; package legacy only after opshub migrates.
> - **T10 (publish):** use the platform repo's release flow (don't `npm publish` from a feature branch); or `pnpm link` for local rova dev.

**Goal:** invite-only users from ANY OIDC directory (extra Entra tenants, Google Workspace, Okta, consumer Google) sign into any platform app through one email-first login — no local passwords, per-connection secrets in AWS SSM, MFA delegated to each IdP.

**Design:** see the v2 spec. Key shifts from v1: **connection-driven provisioning** (route by the resolved connection, not a hardcoded `entra`/`tid`), **connection `kind`** (`directory` domain-routed vs `shared` invite-gated), **mandatory discovery**, **issuer-list + nonce verification**, the **connection schema/contract owned by `@quynhonsemiconductor/identity`**, a **reference `SsmSecretResolver` shipped from the package**, and a **prerelease** so the app can consume the package before GA.

**Tech:** NestJS, Drizzle (Postgres), `jose`, Valkey, Vitest, `@aws-sdk/client-ssm`, React (Vite).

**Repos:** `platform/qnsc-app-platform` (`@quynhonsemiconductor/identity` — mechanism + contract) and `rova` (migration, wiring, endpoint, UI, seed).

**Build order (P1):** do all **package** tasks (T1–T9) → **publish `@quynhonsemiconductor/identity@X.Y.0-rc.1`** (T10) → **app** tasks consume the rc (T11–T17) → **GA publish + bump + cleanup** (T18). During package dev, apps may `pnpm link` the workspace; CI consumes the published rc.

---

## Grounding facts (verified against current code)
- Provisioning today: `auth.service.ts:819` `findByExternalTenantId('entra', externalTenantId)` (hardcoded provider) gated on `if (externalTenantId)` (`:818`) — **null for non-Entra ⇒ gate bypassed / no match**. The gate body (status/domain/`jitEnabled`-invite/platform-admin/workspace+role) is otherwise correct and **reused**.
- Identity link: `userRepo.upsertBySsoIdentity('entra', oid, email, displayName)` — hardcodes provider; must become **connection-scoped** `(connectionId, subject)`.
- `bff.service.beginLogin(rawReturnTo)` + `BffAuthRequest { state, codeVerifier, … }` + a state store (`putAuthRequest`/`takeAuthRequest`) — extend with `email?`, `nonce`, `connectionId`.
- `entra-verifier.ts:93,100` already verifies against an **issuer array** + `audience: clientId` — the generic verifier must preserve the array (C1).
- `sso_connections`: `external_tenant_id` NOT NULL; unique `(provider, external_tenant_id)`; `allowed_email_domains jsonb default []`; **no domain uniqueness** (add it).

---

# PACKAGE (`@quynhonsemiconductor/identity`)

## Task 1: Connection contract — schema SQL + assertion helper + widened type/port
**Files (create/modify under `packages/identity/src`):** `connection/connection.contract.ts` (CREATE), `connection/connection.contract.test.ts` (CREATE), `domain-types.ts` (MODIFY `SsoConnection`), `repository-ports.ts` (MODIFY `ISsoConnectionRepository`).

- [ ] **Contract module** — export the canonical column set as SQL fragments + `assertConnectionContract(query)`: given a `(sql)=>rows` runner, assert `information_schema.columns` for `identity.sso_connections` contains every canonical column with the right type/nullability. Apps import this in an e2e to prevent drift.
- [ ] **Widen `SsoConnection`** (all new fields optional/nullable for legacy rows):
  ```ts
  kind: 'directory' | 'shared';           // default 'directory'
  authorityUrl?: string | null;
  jwksUri?: string | null;
  acceptedIssuers?: string[] | null;      // extra issuers; empty ⇒ [discovery issuer]
  scopes?: string | null;
  clientId?: string | null;
  clientSecretRef?: string | null;
  displayName?: string | null;
  ```
- [ ] **Extend the port:**
  ```ts
  findByExternalTenantId(provider: string, externalTenantId: string): Promise<SsoConnection | null>;
  /** Active `directory` connection that OWNS the email's domain (≤1 by constraint). */
  findDirectoryByEmailDomain(email: string): Promise<SsoConnection | null>;
  /** Active `shared` connection the email has a PENDING INVITE to (consumer IdPs). */
  findSharedByInvitedEmail(email: string): Promise<SsoConnection | null>;
  findById(id: string): Promise<SsoConnection | null>;
  /** Active `shared` connections to render as login buttons. */
  listActiveShared(): Promise<SsoConnection[]>;
  ```
- [ ] Typecheck the package; commit `feat(identity): sso_connections contract + widened type/port`.

## Task 2: `ResolvedConnection` + `SecretResolver` port + config guard
**Files:** `oidc/oidc-connection.ts` (CREATE) + `.test.ts`.
- [ ] `ResolvedConnection` (id, kind, provider, clientId, clientSecret, redirectUri, scopes, issuer, **acceptedIssuers: string[]**, authorizeEndpoint, tokenEndpoint, jwksUri).
- [ ] `SECRET_RESOLVER` symbol + `ISecretResolver { get(ref): Promise<string> }`.
- [ ] `isBrokerConfigured(c)` — **requires `authority_url`** (discovery-mandatory, B2) + `clientId` + `clientSecretRef`. No override branch.
- [ ] Test both booleans; commit.

## Task 3: `OidcDiscovery` (TTL cache)
**Files:** `oidc/oidc-discovery.ts` + `.test.ts`. As v1 (fetch `.well-known`, map issuer/authorize/token/jwks, TTL cache, non-2xx throws). 3 tests. Commit.

## Task 4: `OidcClient` (authorize + **nonce**, exchange)
**Files:** `oidc/oidc.client.ts` + `.test.ts`.
- [ ] `buildAuthorizeUrl(conn, { state, codeChallenge, nonce })` sets `client_id/response_type=code/redirect_uri/response_mode=query/scope/state/code_challenge/code_challenge_method=S256/`**`nonce`**.
- [ ] `exchangeCode(conn, { code, codeVerifier })` → `{ idToken }` (client_secret_post; throw on non-2xx / no id_token).
- [ ] Tests: authorize includes `nonce` + `S256`; exchange returns id_token; no-id_token throws. Commit.

## Task 5: `OidcTokenVerifier` (**issuer list** + audience + **nonce**)
**Files:** `oidc/oidc-verifier.ts` + `.test.ts`. Generalize `entra-verifier`.
- [ ] `verify(idToken, conn, expectedNonce)`:
  ```ts
  const issuers = (conn.acceptedIssuers?.length ? conn.acceptedIssuers : [conn.issuer]);
  const { payload } = await jwtVerify(idToken, jwks, { issuer: issuers, audience: conn.clientId });
  if (expectedNonce && payload.nonce !== expectedNonce) throw new SsoVerificationError('SSO_NONCE_MISMATCH', …);
  // map oid/sub, email(email|preferred_username|upn), name, roles → OidcClaims (= EntraClaims)
  ```
  `OidcClaims = EntraClaims`; reuse `SsoVerificationError`. **No `tid` fallback for routing** — routing is connection-driven (Task 8). `subject = oid ?? sub`.
- [ ] Tests (local JWKS via `jose`): valid maps claims; wrong audience rejected; **wrong issuer rejected but an `acceptedIssuers` alt accepted**; nonce mismatch rejected; missing subject/email rejected. Commit.

## Task 6: `ConnectionRegistry` (kinds + secret + discovery + cache)
**Files:** `oidc/connection-registry.ts` + `.test.ts`.
- [ ] `resolveForEmail(email)`: `findDirectoryByEmailDomain(email)` → else `findSharedByInvitedEmail(email)` → else null. `resolveById(id)`. Each → `resolve(row)`.
- [ ] `resolve(row)`: return null if `status!=='active'` or `!isBrokerConfigured(row)`; `endpoints = discovery.resolve(row.authorityUrl!)`; `clientSecret = secrets.get(row.clientSecretRef!)`; build `ResolvedConnection` (issuer from discovery, `acceptedIssuers = row.acceptedIssuers ?? []`, `redirectUri = this.redirectUri` [injected app config], jwksUri override else discovery). **Short-TTL cache keyed by connection id.**
- [ ] Tests: directory-by-domain resolves; shared-by-invite resolves; disabled/unconfigured → null; unknown → null; cache hit avoids re-fetch. Commit.

## Task 7: `BffService` — email-first + nonce + connectionId
**Files:** `bff.service.ts`, `bff.types.ts`, `bff.service.test.ts`.
- [ ] `BffAuthRequest` gains `nonce: string` + `connectionId: string`.
- [ ] `beginLogin(rawReturnTo, email?)`: if `email` → `conn = registry.resolveForEmail(email)`; null → `UnauthorizedException('NO_CONNECTION', 'No access — contact your administrator')`. Generate `state/pkce/nonce`; `oidc.buildAuthorizeUrl(conn, {state, codeChallenge, nonce})`; persist auth request `{state, codeVerifier, nonce, connectionId: conn.id, returnTo}`. No email → home connection (by a configured home id) same path.
- [ ] `completeLogin`: double-submit state; `authReq = takeAuthRequest(state)`; `conn = registry.resolveById(authReq.connectionId)` (null → 401 — covers mid-session cutoff); `oidc.exchangeCode(conn, …)`; `verifier.verify(idToken, conn, authReq.nonce)`; `authService.ssoLoginFromConnection(conn, claims, ip)` (Task 8); store `connectionId` on the session.
- [ ] Tests: known-domain email → authorize host + persisted connectionId + nonce; unknown email → `NO_CONNECTION`; disabled-mid-session `resolveById`→null → 401. Commit.

## Task 8: Connection-driven provisioning (B1) + `ssoLoginFromConnection`
**Files:** `auth.service.ts`, `auth.service.test.ts`, `repository-ports.ts` (`upsertBySsoIdentity`).
- [ ] **Refactor `resolveAndProvisionSsoUser`** to take the **resolved connection** + claims (no `findByExternalTenantId`, no `'entra'`, no `tid`): route to `connection.workspaceId`/`defaultRoleSlug`; **reuse the existing gate** (`status`, `directory`→domain allowlist, `shared`→require pending invite, `jitEnabled` invite-check, platform-admin break-glass).
- [ ] **Identity keyed by connection (Decision 12):** change the **port** signature to `upsertBySsoIdentity(connectionId, subject, email, displayName, tx?)` and `findSsoIdentity(connectionId, subject)` (was `provider, providerSub`). The Rova **impl** (`user.drizzle-repository`) + **migration** land in T11/T12 — this task only moves the port + `auth.service` call sites.
- [ ] Add `ssoLoginFromConnection(conn, claims, ip)` = the post-verify tail (mint session via existing pipeline). Keep `ssoLogin(idToken, ip)` for the legacy home path (verify with `entra-verifier` then delegate) until cleanup.
- [ ] Tests: directory JIT provisions into the connection's workspace/role; `shared` without invite → rejected; `jitEnabled=false` + uninvited → rejected; platform-admin break-glass allowed; identity upsert keyed by `(connectionId, subject)`. Commit.

## Task 9: Reference `SsmSecretResolver` (package subpath) + barrel
**Files:** `ssm/ssm-secret-resolver.ts` (CREATE), `ssm/index.ts` (CREATE), `package.json` `exports["./ssm"]` + `peerDependencies: @aws-sdk/client-ssm`, `oidc` barrel in `index.ts`, `ssm/*.test.ts`.
- [ ] `SsmSecretResolver implements ISecretResolver` — `GetParameterCommand({Name, WithDecryption:true})`, in-memory TTL cache, empty→throw. Constructed from an injected `SSMClient` (test seam).
- [ ] Export `@quynhonsemiconductor/identity` (oidc/*, connection contract) and `@quynhonsemiconductor/identity/ssm` (resolver). Test the resolver with a stubbed client (no network). Commit.

## Task 10: Prerelease publish (unblocks the app)
- [ ] `cd platform/qnsc-app-platform && npx vitest run packages/identity/src && <typecheck>` → green. Bump `@quynhonsemiconductor/identity` to `X.Y.0-rc.1`; publish per the repo's release flow. Record the version for the app tasks.

---

# APP (Rova) — consumes `@quynhonsemiconductor/identity@X.Y.0-rc.1`

## Task 11: Migrations — connection columns, domain table, identity re-key (Rova)
**Files:** `db/schema/identity.ts`, `db/migrations/0057_sso_connection_oidc_fields.sql`, `db/migrations/meta/_journal.json`.
- [ ] **Connection columns** — add to the `ssoConnections` Drizzle table + SQL: `kind` enum(`directory`,`shared`) default `directory`, `authority_url`, `jwks_uri`, `accepted_issuers jsonb default '[]'`, `scopes` default `'openid profile email'`, `client_id`, `client_secret_ref`, `display_name`. **No `redirect_uri`.**
- [ ] **Owned-domain table (Decision 11)** — create `identity.sso_connection_domains(id, connection_id fk→sso_connections on delete cascade, domain varchar(255) lowercased, created_at)` with `UNIQUE(domain)` + index on `connection_id`. Add the Drizzle table. **Backfill** from existing `allowed_email_domains` where `kind='directory'` (`INSERT … SELECT` unnesting the jsonb, lowercased, `ON CONFLICT (domain) DO NOTHING`). Keep the jsonb column for back-compat.
- [ ] **Identity re-key (Decision 12)** — in the same migration: `ADD COLUMN connection_id uuid REFERENCES sso_connections(id)`; `UPDATE sso_identities SET connection_id = (SELECT id FROM sso_connections WHERE provider='entra' LIMIT 1)` (the sole home connection today); `SET NOT NULL`; drop `uq_sso_identities_provider_sub`; create `UNIQUE(connection_id, provider_sub)`. Update the Drizzle `ssoIdentities` table + unique index. **Guard:** the migration must assert exactly one connection exists before backfilling (else fail loudly — don't guess).
- [ ] Hand-write the SQL migration + journal entry (drizzle-kit needs a TTY — hand-write per repo convention). Apply to dev; verify `\d identity.sso_connections`, `\d identity.sso_connection_domains`, and the new `sso_identities` index. Commit.

## Task 12: Repos — connection lookups + connection-scoped identity (Rova)
**Files:** `sso-connection.drizzle-repository.ts` (+spec), `user.drizzle-repository.ts` (+spec).
- [ ] **Connection repo:** `findDirectoryByEmailDomain(email)` = join `sso_connection_domains` (domain = lowercased email domain) → `sso_connections` filtered `status='active' AND kind='directory'`; `connectionOwnsEmailDomain(connectionId, email)` (gate reuse, same table); `findSharedByInvitedEmail(email)` = active `kind='shared'` connection with a **pending invitation** for that email; `findById`; `listActiveShared`; a `private map(row)` for the new columns; route `findByExternalTenantId` through `map`.
- [ ] **User repo (Decision 12):** change `upsertBySsoIdentity(connectionId, providerSub, email, displayName, tx?)` and `findSsoIdentity(connectionId, providerSub)` to key on `(connection_id, provider_sub)` (set `connection_id` on insert; look up by it).
- [ ] Specs: domain match via the table (case-insensitive, directory only), shared requires a pending invite, no-match→null, column mapping; identity upsert/find keyed by `(connectionId, providerSub)`. Commit.

## Task 13: Wire the broker in Rova DI (Rova)
**Files:** `libs/modules/identity/src/identity.module.ts`.
- [ ] Bind `OidcDiscovery`, `OidcClient`, `OidcTokenVerifier`, `{ provide: SECRET_RESOLVER, useClass: SsmSecretResolver }` (from `@quynhonsemiconductor/identity/ssm`), and `ConnectionRegistry` (factory injecting the connection repo + `SECRET_RESOLVER` + `OidcDiscovery` + `IDENTITY_REDIRECT_URI`). Extend the `BffService` provider to inject them. Keep the legacy Entra providers during transition. Typecheck; commit.

## Task 14: `POST /bff/login/start` + rate-limit + audit (Rova)
**Files:** `bff.controller.ts` (+ `dto/login-start.dto.ts`), controller test.
- [ ] `@Public() @Post('login/start')` with `LoginStartDto { email: string; returnTo?: string }`; **rate-limited** (existing throttler guard); call `beginLogin(returnTo, email)`; set the `__Host` state cookie; return `{ authorizeUrl }`. `NO_CONNECTION` → 401. Keep `GET /bff/login` (home) + `GET /bff/callback` (routes by stored connectionId — no change).
- [ ] Emit `login.started/succeeded/failed` audit events (connectionId + email domain) via the platform audit bus.
- [ ] Test: known-domain → 200 + authorizeUrl + cookie; unknown → 401 `NO_CONNECTION`; rate-limit trips. Commit.

## Task 15: Seed home connection + env (Rova)
**Files:** `db/seeds/bootstrap.ts`, `libs/platform/src/config/env.schema.ts`.
- [ ] Seed the home `directory` connection (idempotent `onConflictDoUpdate`): `kind='directory'`, `authorityUrl=https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`, `acceptedIssuers=[v2 issuer, https://sts.windows.net/${ENTRA_TENANT_ID}/]` (C1), `clientId=ENTRA_CLIENT_ID`, `clientSecretRef=IDENTITY_HOME_SECRET_REF`, `scopes`, `displayName='QNSC (home)'`, `allowedEmailDomains` from env.
- [ ] Env: add `IDENTITY_REDIRECT_URI` (single callback), `IDENTITY_HOME_SECRET_REF`, `IDENTITY_HOME_EMAIL_DOMAINS`. Put the home secret in SSM (dev: LocalStack param) at `IDENTITY_HOME_SECRET_REF`; keep `ENTRA_CLIENT_SECRET` as the legacy-path fallback during transition. Re-seed dev; verify. Commit.

## Task 16: Email-first login UI (Rova)
**Files:** `apps/web/src/pages/login/login-page.tsx`.
- [ ] Email input + submit → `POST /v1/bff/login/start` → follow `authorizeUrl`; 401 → "No access — contact your administrator". Keep the MS home button; render a button per `listActiveShared()` connection (`display_name`). Match the dark login card. Typecheck; commit.

## Task 17: E2E — resolution, provisioning, cutoff, contract (Rova)
**Files:** `test/e2e/sso-multi-connection-flow.e2e.spec.ts`, `test/e2e/sso-connection-contract.e2e.spec.ts`.
- [ ] Contract test: `assertConnectionContract` from the package against the real DB.
- [ ] Seam test (real DB + stub secret/discovery injected): seed home + `directory` vendor.com (+ optionally a `shared` Google with a pending invite). `resolveForEmail('x@vendor.com')`→resolves; `'x@nowhere.com'`→null; shared email without invite→null, with invite→resolves; flip vendor `disabled`→null (**cutoff**); `ssoLoginFromConnection(vendorConn, claims)`→user in vendor workspace/role; identity keyed `(connectionId, subject)`.
- [ ] (Optional) mock-OIDC container for one full authorize→callback→session. Run e2e; commit.

## Task 18: GA publish + bump + runbook + cleanup
- [ ] Package green → **GA publish** `@quynhonsemiconductor/identity@X.Y.0`; bump Rova off the rc; `pnpm i`.
- [ ] Full verify (Rova): `tsc -b`, web `tsc`, `vitest run`, e2e — all green.
- [ ] `docs/runbooks/add-sso-connection.md`: (1) put the IdP secret in SSM `/…/sso/<slug>/client_secret`; (2) insert an `sso_connections` row (`kind`, `provider`, `external_tenant_id`, `authority_url`, `client_id`, `client_secret_ref`, `allowed_email_domains` [directory] or invite [shared], `default_role_slug`, `workspace_id`, `status=active`); (3) register `IDENTITY_REDIRECT_URI` in the IdP; (4) test; (5) engagement end → `status='disabled'` (instant cutoff).
- [ ] Post-verify: remove the legacy `EntraOidcClient`/`entra-verifier`/`GET /bff/login` shims once the home connection is confirmed on the generic path. Commit.

---

## Self-review (coverage of the v2 review)
- **B1 connection-driven provisioning:** T8 (refactor + port) + T7 (route by stored connectionId) + T11/T12 (`sso_identities` re-key to `(connection_id, provider_sub)`, Decision 12).
- **B2 discovery-mandatory:** T2 `isBrokerConfigured` requires `authority_url`; no override branch.
- **S1 domain uniqueness:** T11 normalized `sso_connection_domains` table with `UNIQUE(domain)` (Decision 11) + T12 domain-table lookups.
- **S2 kinds (directory vs shared / Gmail invite-gated):** T1 `kind` + port; T6 `resolveForEmail`; T8 shared-requires-invite; T12 queries.
- **S3 gate off resolved connection:** T8.
- **S4 rate-limit + audit + nonce:** T14 (throttle+audit), T4/T5/T7 (nonce).
- **C1 issuer list:** T5 verifier + T15 `acceptedIssuers` seed.
- **C2 connectionId on session:** T7.
- **D1 single redirect_uri:** T11 (no column) + T13/T15 env.
- **P1 sequencing:** T10 prerelease before app tasks; T18 GA.
- **M365:** per-IdP MFA (no P1) — design/runbook; cost — no guests (JIT local users); Gmail = shared+invite (T8/T12).
- **Platform ownership:** contract (T1), reference SSM resolver at `/ssm` (T9), generic `IDENTITY_*` naming (T13/T15).
- **Back-compat:** legacy shims retained through T17, removed in T18 post-verify.
- **Open risk:** SSM param must exist before a connection goes active (runbook step 1 precedes insert); discovery needs outbound HTTPS to each IdP.

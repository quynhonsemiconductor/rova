# Multi-IdP Authentication Broker — Design Spec (v2)

**Date:** 2026-07-23 (revised) · **Status:** Green-light ready · **Author:** Technical Solution Lead
**Scope:** `qnsc-app-platform/packages/identity` (the shared broker — owns the mechanism *and* the connection contract) + each consuming app (Rova first: login UI, seed, DI wiring). Cross-repo.

> **v2 changes** (from the v1 review): provisioning is now **connection-driven** (no hardcoded `entra`), connections have a **kind** (`directory` vs `shared`) so consumer IdPs like Gmail are invite-gated not domain-gated, discovery is **mandatory** (no broken override branch), the verifier accepts an **issuer list** (Entra v1/v2), auth requests carry **nonce + connectionId**, the connection **schema is owned by the platform package**, and the cross-repo build order is fixed with a **prerelease**. Corrected for the company's **M365 Business Standard** licensing (no Entra P1).

> ## ⚠️ Implementation revisions (2026-07-24) — these SUPERSEDE conflicting text below
> The package half (T1–T9) is built; these decisions were made/validated during implementation and override earlier wording:
> 1. **Secret store → AWS Secrets Manager, not SSM (Decision 8).** SSM in this infra is `type=String` for *non-sensitive config*; the paved path for secrets is **Secrets Manager** (CMK, IAM, empty-in-IaC/value-out-of-band). The concrete resolver (`SecretsManagerSecretResolver`) is **app-side (Rova)**; the package ships only the store-agnostic **`SecretResolver` port** (no `@quynhonsemiconductor/identity/ssm` subpath, no aws-sdk in the core package). Secrets live under `arn:…:secret:rally/${env}/sso/*`.
> 2. **IaC (new work, all Terraform):** add a **task-role** policy `secretsmanager:GetSecretValue` on `rally/${env}/sso/*` + `kms:Decrypt` on the shared CMK (today only the *execution* role reads secrets, for boot-time env injection — the broker reads at **runtime**). Adopt the `rally/${env}/sso/*` prefix. Verify the shared CMK key policy allows the task role + runtime egress to Secrets Manager (VPC endpoint/NAT). Secret **values** stay manual/out-of-band. Rotation is a separate hygiene follow-up (no auto-rotation configured today).
> 3. **SSO-identity key → `(provider-namespace, provider_sub)`, NOT `(connectionId, subject)` (revises Decision 12 / §3).** `identity.sso_identities` is **unchanged** (keeps its `(provider, provider_sub)` unique index — **no `connection_id` column, no re-key migration**). The broker keys identities by the connection's **`provider`** value (entra/google/okta), which also works for single-tenant `opshub` (connectionless identities). B1's real fix — connection-driven *routing/gating* — stands. (Rare same-provider-multi-connection-same-subject collisions are an accepted, documented edge.)
> 4. **Registry has no cache (instant cutoff).** `ConnectionRegistry` does not cache the assembled connection — it re-reads the row each resolve, so `status='disabled'` locks out immediately. Expensive I/O is cached in `OidcDiscovery` + the `SecretResolver`.
> 5. **Single gate.** One `assertConnectionAllows` (status/owned-domain/invite-only break-glass) is shared by the legacy home path and the broker.
> 6. **Structure.** All broker code lives under `packages/identity/src/oidc/`.
> 7. **Legacy retained.** `EntraOidcClient`/`entra-verifier`/`ssoLogin` stay (opshub depends on them; broker deps are `@Optional`). Staged retirement: Rova home route at T18; package legacy only after opshub migrates + shared claim/error types are relocated to a neutral module.

---

## 1. Problem & Goal

Rova authenticates only through a **single hard-coded Entra tenant** (BFF Auth-Code + PKCE). External teams — an outsourced vendor with its own directory, freelancers on Google — cannot sign in. The company is invite-only and runs on **M365 Business Standard** (Entra ID **Free** — app registrations + OIDC, security-defaults MFA, **no Conditional Access / P1**).

**Goal:** turn `@quynhonsemiconductor/identity` into a **provider-agnostic OIDC broker** driven by the `sso_connections` registry, reusable by **any** platform app, so any OIDC IdP (extra Entra tenants, Google Workspace, Okta, consumer Google) is federated by adding a connection — **no local passwords, one code path per IdP, near-zero running cost**.

### Why the broker (vs Entra B2B guests) on Business Standard
- **MFA without P1:** each federated IdP enforces **its own** MFA (the vendor's tenant, Google Workspace). We get strong auth on external users *without* buying Entra P1/Conditional Access — which Business Standard doesn't include.
- **Near-zero cost:** external users authenticate against **their own** IdP and are JIT-provisioned as **local app users** — they are **not guests in our tenant**, so we avoid Entra External ID MAU billing and guest-management overhead. (Confirm exact External-ID free-MAU limits with the M365 admin; the architecture avoids that meter entirely.)
- **Flexibility:** Google/Okta/any-OIDC are first-class, not shoe-horned through Entra B2B.

### Non-goals (YAGNI)
- Local email/password auth (the broker removes the need).
- Self-serve admin UI for connections — managed via **seed/config**; a future increment.
- In-app MFA — delegated to each federated IdP (see above). The home tenant uses M365 security defaults.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Home for the code | Shared **`@quynhonsemiconductor/identity`** — owns the broker mechanism **and** the `sso_connections` contract (schema + contract test). Consuming apps only wire + seed. |
| 2 | Federation model | **Generic per-connection OIDC** — one code path; each connection is a self-describing IdP resolved from a row. |
| 3 | Connection **kind** | `directory` (a directory that **owns** its email domains → domain-routed, JIT-by-domain) **vs** `shared` (a shared/consumer IdP we don't own, e.g. consumer Google → **invite-gated**, never domain-routed). |
| 4 | Provisioning | **Connection-driven**: `completeLogin` resolves the connection, then provisioning routes by the **resolved connection's id/workspace/role** — never by re-deriving `tid`/`provider` from claims. SSO identity keyed by **`(connectionId, subject)`**. |
| 5 | Login UX | **Email-first**: type email → domain → `directory` connection → IdP. Keep the home "Sign in with Microsoft" quick button; optional per-`shared`-connection buttons ("Sign in with Google"). **Unknown/unmatched ⇒ denied** ("contact administrator"). |
| 6 | Discovery | **Mandatory** `.well-known/openid-configuration` per connection (via `authority_url`), TTL-cached. `jwks_uri` / extra `accepted_issuers` are optional overrides. No hand-entered authorize/token endpoints. |
| 7 | Token verification | Strict **issuer(s) + audience** match against the resolved connection. `accepted_issuers` allows the Entra v1 (`sts.windows.net`) + v2 pair; default `[discovery issuer]`. **`nonce`** bound to the auth request. |
| 8 | Secret storage | **`SecretResolver` port** in the package (store-agnostic, no aws-sdk). Concrete impl is **app-side**: Rova uses **`SecretsManagerSecretResolver`** (AWS Secrets Manager — the infra's paved path for secrets: CMK-encrypted, empty-in-IaC/value-out-of-band). SSM is **not** used (it's `String`/non-sensitive config here). Secrets under `rally/${env}/sso/*`; DB holds only a **ref**. |
| 9 | Redirect URI | **One app-level** `IDENTITY_REDIRECT_URI` (the shared `/bff/callback`); `state` carries the connectionId. **Not** per-connection. |
| 10 | Cutoff | `status='disabled'` on the connection = instant lockout for that directory (the 2-year switch). |
| 11 | Owned-domain storage (S1) | Normalized **`identity.sso_connection_domains(connection_id, domain UNIQUE)`** table is the **source of truth** for a `directory` connection's owned domains — used for **both** routing and the provisioning gate. `allowed_email_domains` jsonb is retained for back-compat and **backfilled** into the table; a `UNIQUE(domain)` makes domain→connection unambiguous. `shared` connections have **no** rows here. |
| 12 | SSO-identity key (B1) | `identity.sso_identities` is re-keyed from `(provider, provider_sub)` to **`(connection_id, provider_sub)`** — add `connection_id` (FK → `sso_connections`), swap the unique index, **backfill existing rows → the home connection** (there is exactly one connection today, so the backfill is deterministic and safe). This makes identity linkage connection-scoped and provider-agnostic. |

---

## 3. Data model — `sso_connections` (contract owned by the package)

**The package owns the canonical column set + a `assertConnectionContract(db)` test helper.** Each app includes the shared migration and runs the contract test so schemas never drift.

Existing columns kept: `id`, `workspace_id`, `provider`, `external_tenant_id`, `issuer`, `default_role_slug`, `allowed_email_domains`, `jit_enabled`, `status`, timestamps.

Add (migration):
| Column | Type | Purpose |
|---|---|---|
| `kind` | enum(`directory`,`shared`) not null default `directory` | routing/gating model (Decision 3) |
| `authority_url` | varchar(512) | OIDC issuer base for **mandatory** discovery |
| `jwks_uri` | varchar(512) null | optional override (else from discovery) |
| `accepted_issuers` | jsonb `string[]` default `[]` | extra accepted issuers (Entra v1/v2); empty ⇒ `[discovery issuer]` |
| `scopes` | varchar(255) not null default `'openid profile email'` | |
| `client_id` | varchar(255) | public IdP client id |
| `client_secret_ref` | varchar(512) | **ref** into the secret store (never the secret) |
| `display_name` | varchar(255) | human label for the login button + logs/audit |

Constraints:
- Existing unique `(provider, external_tenant_id)` retained.
- **No `redirect_uri` column** (Decision 9).

**Owned domains — normalized (Decision 11).** A `directory` connection's domains live in a dedicated table (not a jsonb array), so `UNIQUE(domain)` guarantees a domain maps to at most one connection:

```
identity.sso_connection_domains
  id            uuid pk default gen_random_uuid()
  connection_id uuid not null references identity.sso_connections(id) on delete cascade
  domain        varchar(255) not null          -- stored lowercased
  created_at    timestamptz not null default now()
  UNIQUE (domain)                               -- one connection owns a domain, globally
  INDEX (connection_id)
```
This table is the source of truth for **routing** (`findDirectoryByEmailDomain`) *and* the **provisioning gate** (`connectionOwnsEmailDomain`). `allowed_email_domains` jsonb is kept for back-compat and **backfilled** into it (migration), then can be dropped in a later cleanup. `shared` connections have no rows here.

**SSO-identity key — provider-namespace (revised 2026-07-24; supersedes the earlier "connection-scoped / Decision 12" plan).** `identity.sso_identities` is **unchanged** — it keeps its existing `(provider, provider_sub)` unique index. **No `connection_id` column and no re-key migration.** The broker keys identities by the connection's **`provider`** namespace (entra/google/okta), which also fits single-tenant `opshub` (connectionless identities) and needs no risky schema change. Realistic collisions are covered (Entra `oid` is per-tenant unique; Google/Okta `sub` is globally unique); the rare same-provider-multi-connection-same-subject case is an accepted, documented edge. `upsertBySsoIdentity`/`findSsoIdentity` keep their `(provider, providerSub)` signature — the broker passes `connection.provider`.

The current single Entra config is **seeded as the home `directory` connection**; fully backward-compatible.

---

## 4. Components (`packages/identity`, small · single-purpose · DRY)

One code path for every IdP. Generalize the Entra-specific pieces; keep them as thin back-compat shims.

- **`OidcDiscovery`** — fetch + TTL-cache `.well-known/openid-configuration` (authorize/token/jwks/issuer). Injectable `fetch`/clock for tests.
- **`OidcClient`** — provider-agnostic `buildAuthorizeUrl(conn, {state, codeChallenge, nonce})` + `exchangeCode(conn, {code, codeVerifier})`. Reads endpoints from the resolved connection.
- **`OidcTokenVerifier`** — verify id_token against the connection's **issuer list** (`accepted_issuers` ∪ discovery issuer) + **audience=client_id** + **nonce**; map claims to the shared `OidcClaims` (= `EntraClaims`) shape.
- **`SecretResolver`** (port) + **reference `SsmSecretResolver`** shipped at `@quynhonsemiconductor/identity/ssm` (peer-dep `@aws-sdk/client-ssm`), in-memory TTL cache.
- **`ConnectionRegistry`** — `resolveForEmail(email)` (directory-by-domain **or** shared-by-invite), `resolveById(id)`; loads the row, resolves the secret + discovery, returns a fully-formed `ResolvedConnection`; short-TTL cache keyed by connection id + secret version. Excludes `disabled`/misconfigured rows.
- **`bff.service`** — `beginLogin(returnTo, email?)` (email→connection routing, persists **state + PKCE + nonce + connectionId**) and `completeLogin` (routes by stored `connectionId`).
- **`auth.service`** — `resolveAndProvisionSsoUser(connection, claims)`: **connection-driven** (reuses the existing status/domain/JIT-invite/platform-admin gate, routes to `connection.workspaceId`/`defaultRoleSlug`), identity keyed by `(connectionId, subject)`.
- **Reused unchanged:** `bff-session.store` (session mint + refresh rotation), JIT provisioning gate logic, `SsoProvisioningHook`, `authMethod`.
- **Back-compat shims (kept, then removed post-cutover):** `EntraOidcClient`, `entra-verifier`, `GET /bff/login` home path.

---

## 5. Login / auth flow (email-first)

1. **`POST /bff/login/start { email, returnTo }`** (rate-limited; `@Public()`):
   - `ConnectionRegistry.resolveForEmail(email)`:
     - **directory:** the `directory` connection that owns the email's domain.
     - **shared:** if no directory owns the domain, but the email is on a **pending invitation** bound to a `shared` connection → that connection. (Reuses the existing invitation system — DRY.)
   - none ⇒ **401 `NO_CONNECTION`** → UI: "No access — contact your administrator."
   - else build authorize URL (`OidcClient`) with per-request **state + PKCE + nonce**; persist the auth request keyed to `state` with `connectionId`; return the redirect. **Emit `login.started` audit** (connectionId, email domain).
2. **Home / shared quick buttons** — "Sign in with Microsoft" (home connection) and any `shared` connection buttons call `start` for that connection directly.
3. **`GET /bff/callback?code&state`** — double-submit state check; resolve connection from the stored `connectionId`; `exchangeCode`; `verify` (issuer list + audience + nonce); **connection-driven provisioning** (idempotent upsert by `(connectionId, subject)` into the connection's workspace/role, through the existing gate); mint session (`connectionId` stored on the session for silent re-auth); same-origin `returnTo` guard. **Emit `login.succeeded`/`login.failed`.**
4. **Refresh / silent re-auth** — session rotation unchanged; the session's **`connectionId`** (not just provider) drives re-auth routing.

---

## 6. Security

- **Connection-driven authorization (S3):** every gate (active status, domain allowlist for `directory`, invite check for `shared`, `jit_enabled`, platform-admin break-glass, workspace/role) runs off the **resolved connection** — a token from IdP A can never be provisioned into connection B.
- **Strict token binding:** issuer(s) + audience + **nonce**; PKCE `S256`; single-use `state` (double-submit cookie). id_token is fetched server-side from the token endpoint (BFF), never through the browser.
- **Domain routing safety (S1/S2):** only `directory` connections (owned domains) are domain-routed, with **at-most-one-active-connection-per-domain**. `shared` IdPs (consumer Google) are **never** domain-routed — reachable only via an explicit button **and** gated by a pending invitation at provisioning, because we don't own `gmail.com`.
- **Secrets:** DB holds a **ref**; `SecretResolver` fetches at use, TTL-cached in memory. Rotating = update the SSM param; cache expires within TTL.
- **Cutoff:** `status='disabled'` ⇒ `resolveForEmail`/`resolveById` return null ⇒ immediate lockout (one-row flip).
- **Abuse:** `/bff/login/start` is rate-limited; the generic `NO_CONNECTION` message avoids confirming *which* domains are federated (mild enumeration guard).
- **Audit (compliance):** per-connection `login.started/succeeded/failed` events via the platform audit bus — required for the external-vendor engagement.

---

## 7. Frontend (per-app; Rova first)

Minimal change to the existing dark login card:
- **Email input** + submit → `POST /bff/login/start` → follow the redirect.
- Keep **"Sign in with Microsoft"** (home) + render a button per active `shared` connection (`display_name`).
- `401 NO_CONNECTION` → inline "No access — contact your administrator."
- Extract a **shared login component** once a second app adopts the broker.

---

## 8. Platform ownership & reuse (any app, long-term)

- **Schema contract in the package:** canonical column set + `assertConnectionContract(db)`; apps include the shared migration and run the contract test (no per-app drift).
- **Reference `SsmSecretResolver`** at `@quynhonsemiconductor/identity/ssm` — apps bind it; port stays open for alternatives (Secrets Manager, Vault).
- **Generic vocabulary** in the shared layer: "default/home connection", a generic `IDENTITY_*` config contract. `ENTRA_*`/`SSO_HOME_*` names stay as *app* config only.
- **Additive + back-compat:** existing consumers keep working until they add connections; legacy Entra shims retained through transition.

---

## 9. Backward compatibility & migration

- Migration adds columns (nullable / defaulted) + seeds the existing Entra config as the **home `directory` connection**.
- Existing "Sign in with Microsoft" keeps working — routed through the generic client against the home connection (validated against real tokens, incl. the Entra v1 issuer via `accepted_issuers`).
- Other apps inherit the broker but behave identically until they add connections.

---

## 10. Testing

**Unit (package):** `OidcDiscovery` (map + cache + non-2xx); `OidcClient` (authorize incl. nonce, exchange, no-id_token); `OidcTokenVerifier` (valid, wrong-audience, wrong-issuer, missing-nonce, missing-claims, **issuer-list accepts v1 & v2**); `ConnectionRegistry` (directory-by-domain, shared-by-invite, disabled/misconfigured→null, unknown→null); `SsmSecretResolver` (cache, empty→throw, mocked—no network); connection-driven provisioning gate (domain/JIT/invite/admin).

**E2E (real app + DB):** seed two connections (home Entra + a `directory` "vendor.com" + optionally a `shared` Google); `resolveForEmail` resolves/denies correctly; provisioning lands users in the **connection's** workspace/role; flip `disabled` → cutoff; **contract test** passes. Optional: a **mock-OIDC container** to exercise the full authorize→callback→session once.

---

## 11. Rollout

1. Package: schema contract + generic OIDC (discovery/client/verifier) + registry + connection-driven provisioning, behind the existing home flow (regression-safe). **Publish a prerelease** (`-rc`).
2. App: consume the prerelease; migration + seed home connection (no behavior change); wire DI + reference SSM resolver.
3. Add `POST /bff/login/start` + email-first UI (+ rate-limit + audit).
4. Add a `directory` vendor connection in non-prod; verify federation + JIT + cutoff. Add a `shared` Google connection gated by invite.
5. GA-publish the package; bump the app; write the **add-a-connection runbook**. Remove legacy Entra shims once the home connection is verified on the generic path.

---

## 12. Resolved review items (traceability)
B1 connection-driven provisioning (§4/§5/Dec 4) · B2 discovery-mandatory (§3/Dec 6) · S1 domain uniqueness (§3/§6) · S2 directory-vs-shared kinds (§2/§5/§6) · S3 gate off resolved connection (§6) · S4 rate-limit + audit + nonce (§5/§6) · C1 issuer list (§3/§4/Dec 7) · C2 connectionId on session (§5) · D1 single redirect_uri (Dec 9) · P1 prerelease sequencing (§11) · M365 per-IdP MFA + cost + Gmail-as-shared (§1). · Ownership: schema contract + reference resolver + generic naming (§8).

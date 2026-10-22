# Auth convergence: one model, two products

Status: **rova side implemented** (#234, #238, #241). opshub side is the plan.
Written 2026-07-28.

## Why this document exists

rova and opshub are meant to stay boilerplate-identical, and their authentication
mechanism already is — it lives in `@quynhonsemiconductor/identity`. Their **authorization** did
not: rova authorized from a permission list embedded in the access token, opshub
from the database with scope dimensions. Both were internally coherent, so the
question "which one is right?" kept getting re-litigated from taste rather than from
evidence.

This records the answer, the reasoning, and what each product must do — so the next
person does not have to reconstruct it, and so the opshub port has a target instead
of an argument.

The related boundary rule — what may live in a *shared package* at all — is in
[`qnsc-app-platform/docs/ADMISSION-TEST.md`](https://github.com/QNSC-VN/qnsc-app-platform/blob/main/docs/ADMISSION-TEST.md).
This document is about the model both products implement in their own code.

## The canonical model

1. **The token carries identity only.** No permissions, no roles-as-authority, no
   epoch. A token is a mint-time snapshot; anything authoritative inside it is stale
   by construction.
2. **One resolver.** Effective permissions come from the database, cached per
   (workspace, user) in Valkey with a bounded TTL, and **invalidated by the write
   paths after commit**. The TTL is a backstop for a missed invalidation, not the
   mechanism.
3. **One guard, one decorator.** A single `PolicyGuard` is the only authorization
   decision point. Tier safety is enforced by decorator overload: a workspace-tier
   code takes no scope, a project/resource-tier code requires one.
4. **Declarative scope, not closures.** Scope is a descriptor —
   `{ from: 'param'|'query'|'body', field }`, or `{ resource, from, field }` to
   resolve by loading the row — handled by one shared resolver. Not a per-route
   callback: those cannot be audited statically and every route re-hand-rolls the
   extraction.
5. **Typed catalogue.** Permission codes come from one file that is also the seed
   source, with a derived union type, so a typo is a compile error and the database
   cannot drift from the code.
6. **Browser auth is BFF.** Opaque `__Host-<product>_session` cookie, server-side
   Valkey session, no token in JS. Bearer stays for machine clients.
7. **IdP roles map in through a hook.** Entra App Roles reconcile to global role
   assignments tagged with their origin, so a human-granted role is not silently
   revoked by the next login.

Failure policy: resolution **degrades to the database** on a cache error — it does
not fail open. Only the token denylist and the rate limiter fail open, and both are
tagged `securityFailOpen` for the CloudWatch alarm.

## Which product was right about what

Neither, wholly. The model above takes opshub's resolution timing and rova's
decorator shape.

| axis | winner | why |
| --- | --- | --- |
| resolution timing (DB per request, cached) | **opshub** | rova's token snapshot needed an epoch counter to expire early — a workaround, not a fix |
| scope dimensions (`global/self/team/dept/region`) + delegation + expiry | **opshub** | rova only has workspace/project |
| fail policy | **opshub** | fail-closed resolution |
| decorator shape (typed overloads, declarative scope, shared resolver) | **rova** | opshub's `scopeFrom` closures are unauditable and duplicated per route |
| permission typing (catalogue + contract specs) | **rova** | opshub's keys are `string`, so a typo compiles |
| isolation tests driving the real guard against a real DB | **rova** | opshub has none |
| IdP → role mapping | **opshub** | rova has no equivalent; Entra owns "who is an admin" in one place |

## What rova did (done)

- `#234` — one decision point. Migrated the last 25 routes onto `PolicyGuard`, then
  deleted the legacy path. rova had **two decorators named `RequirePermission`**
  enforced by different guards; importing the wrong one compiled, and the
  route-policy ratchet counted both as policed.
- `#238` — DB-resolved permissions. Deleted `claims.permissions`, the
  `AuthzEpochService`, the epoch check in `JwtAuthGuard`, and the BFF `remint` path
  that existed only to service epoch staleness. A grant or revocation now lands on
  the user's **next request**, on every replica.
  - Closed two holes found on the way, both from reading the token: the
    no-escalation check judged the actor by their *token* (so an admin whose grant
    had just been revoked could still hand it out), and the project tier
    fast-pathed a workspace-wide grant from the token.
  - Project-tier checks are cached for the first time (was an uncached join per
    request).
- `#241` — pinned `@quynhonsemiconductor/identity` to exact `6.0.0`, which is also what proved
  the package's v6 trim was safe in a real consumer.

Still open in rova: project scope is **additive** — a project-scoped role can add
permissions but cannot subtract a workspace-wide grant (`RALLY_HARDENING_PLAN.md`
R3). opshub's scope evaluator does not have this limitation, so converging on its
engine would close it.

## What opshub must do

Ordered; each item is a PR. Items 1 and 3 are independent of the infra work.

1. **Typed catalogue.** Extract role/permission definitions out of `db/seed.ts` into
   `db/permissions.catalog.ts` (+ a `@db/*` tsconfig path), re-export via
   `@shared-kernel`, narrow `PermissionRequirement.permission` from `string` to the
   derived union. Port the two contract specs.
2. **Retire `RoleGuard`.** It reads the JWT `roles` claim — a second, stale
   authorization path beside the DB-resolved one. Cheap now: 19 `@Auth()` sites are
   no-op role checks and there is exactly **one** real `@RequireRoles`.
3. **Adopt the declarative decorator.** Replace per-route `scopeFrom` closures with
   descriptors over opshub's existing `ScopeEvaluator`, keeping its scope dimensions.
4. **Tag assignment origin.** Add `origin` (`entra` | `manual`) to
   `user_role_assignments` and reconcile only `origin='entra'` in
   `EntraRoleProvisioningHook`. Today a global role granted by a human in the UI is
   **silently revoked** at that user's next login.
5. **Shared cache in develop** (drops the per-task Valkey sidecar) — prerequisite
   for BFF sessions, which cannot live in a per-task cache.
6. **CSRF enforcement, then BFF**: cookie session + Pages Function proxy; delete
   `msal.ts` and the in-memory token store.
7. **Entra revocation reconcile job.** Removing an App Role in Entra is currently
   observed only at the user's next login, because the hook is the only writer.
8. **Isolation tests.** Port rova's `project-isolation.e2e.spec.ts` shape: drive the
   real guard against a real seeded DB.

opshub keeps: its resolver, `ScopeEvaluator`, delegation, expiry filter,
fail-closed policy, and the Entra hook. It does **not** adopt rova's
project/workspace tier split.

## Things not to do

- **Do not reintroduce permissions into the token.** That snapshot is what forced
  the epoch counter, and the epoch is what forced the BFF re-mint path.
- **Do not create a shared `@quynhonsemiconductor/authz` package.** The shared package already
  contained an authorization guard; both products abandoned it, and its wildcard
  vocabulary was unusable by one of them. Share the *shape*, copy the code — see the
  admission test.
- **Do not trust a principal's `permissions` array.** It is inert in rova. An e2e
  fixture cannot grant itself anything by declaring one; it needs a real assignment
  (`ensureViewerGrant` in `test/e2e/support/flow-harness.ts`).
- **Do not add a route without `@RequirePermission`** and assume it is closed.
  `PolicyGuard` allows a handler with no policy metadata, which is why
  `test/route-policy.ratchet.spec.ts` counts undecorated handlers and only ever lets
  the number fall.

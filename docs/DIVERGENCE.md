# Declared divergence from opshub

rova and opshub share one architecture on purpose, and the boilerplate is meant to
stay identical: `.github/workflows`, `infra/`, `libs/platform`, `libs/shared-kernel`,
`apps/*/bootstrap`, `apps/web/src/{shared,app}`.

Where they differ, it is either **declared here** or it is drift. The point of the
list is that an unlisted difference is a bug, so nobody has to guess whether they
found a decision or an accident.

Keep the opshub copy of this file in sync — it is the same register from the other
side.

## Allowed: product domain

Not drift, never converging. Rova plans software delivery; opshub runs IT
operations.

| | rova | opshub |
| --- | --- | --- |
| domain modules | work items, iterations, releases, milestones, backlog, quality, SCM | assets, access requests, compliance, workforce, licences, security posture, catalog |
| tenancy | workspace-scoped (`contextId` is the workspace) | single-tenant (`contextId` unused) |
| permission vocabulary | `namespace:action` with `ns:*` wildcards (`work_item:edit`) | `resource.action` with `*` wildcard (`asset.read`) |

The vocabulary difference is why `permissionGrants` could not stay in the shared
package: its `ns:*` semantics cannot express opshub's dotted codes.

## Allowed: authorization scope model

| | rova | opshub |
| --- | --- | --- |
| scope dimensions | `global`, `workspace`, `project` | `global`, `self`, `team`, `dept`, `region` |
| delegation | none | `authz/delegation.service.ts` |
| grant expiry | none | `expiresAt` on assignments |
| IdP role mapping | none | Entra App Roles → global assignments |
| custom roles | editor UI + backend CRUD | none |

Both resolve from the database, cached per user, invalidated on write — that part is
the same model (`docs/superpowers/specs/2026-07-28-auth-convergence.md`). Only the
dimensions differ, and they differ because the products do.

**Convergence intent:** opshub's evaluator is the more general one. If rova ever
needs to *subtract* a permission at project scope — the additive-only limitation in
`RALLY_HARDENING_PLAN.md` R3 — the answer is to adopt opshub's shape, not to invent
a third.

## Allowed: how domain events reach their read model

| | rova | opshub |
| --- | --- | --- |
| transport | DB-to-DB. `AuditProjectionRelay` polls `messaging.outbox_events` and writes `audit.audit_logs` | none — the generic domain-event outbox was removed (opshub migration 0013) |
| consumers | one, in-process | n/a |
| audit writes | asynchronous, through the projection | synchronous, `AuditService` in the request path |

Rova deleted its SNS topic and four SQS queues to get here, and the reason is worth
carrying over before opshub grows a consumer: the queue leg was broken in every
deployed environment for as long as it existed, in three independent ways at once
(the audit queue had no subscription, the one subscription that existed filtered on
event types the code never emits, and the module set no `raw_message_delivery`).
Nothing alarmed, because SNS reports a publish with no matching subscription as a
success — develop measured 12 published, 12 FilteredOut, 0 delivered, **0 failed**.
Local dev worked throughout, because the LocalStack bootstrap subscribed all four
queues unfiltered with raw delivery on: it was more permissive than the Terraform, so
dev could not reproduce prod.

**opshub reached the same conclusion from the other end and deleted its leg outright**
(opshub #123, migration 0013). Its `outbox_events` published to an SQS queue nothing
consumed, and nothing read the table either — every `enqueue` call sat immediately
beside a `webhookEnqueue.fanout` for the same event and payload, so the outbox copy was
a second write of something already delivered. Notifications, email, webhooks and audit
each had their own path with a real reader, which is why nobody missed it.

So neither product now has a generic domain-event bus. rova has a DB-to-DB projection
with one reader; opshub has three purpose-built outboxes, each with a consumer. Both
kept the shared `AbstractOutboxRelay`, its backoff and metrics, and the
`outboxDeadLetter` alarm.

**If either product grows a real cross-product or external consumer, build the leg WITH
the consumer and an end-to-end test in the same change.** The failure above did not come
from a missing feature; it came from a pipeline whose middle nothing exercised.

## Temporary: rova is ahead, opshub should catch up

Tracked as work, not as divergence. Ordered plan in the convergence spec.

| gap | opshub state as of 2026-07-28 |
| --- | --- |
| typed permission catalogue + contract specs | keys are `string`; a typo compiles |
| single guard, declarative scope descriptors | `RoleGuard` (JWT roles, stale) coexists with `PolicyGuard`; scope via per-route closures |
| BFF browser auth | MSAL in-page, access token in JS memory |
| CSRF enforcement | only on `/v1/auth/refresh` |
| shared cache in develop | per-task Valkey sidecar |
| `infra/modules/stack` | develop and prod duplicate ~370 lines each |
| deploy on infra change | `infra/**` still in `paths-ignore`, so a Terraform-owned env change registers a task definition nothing rolls onto |
| observability package + alarms | not adopted; no alarms |
| migration-upgrade CI job, expand-contract advisory, deploy gating | absent |
| e2e depth | no Playwright, no service-level flow suite |
| R2 storage | S3 app-buckets, while `opshub_attachments_*` R2 buckets already exist unused |

## Temporary: opshub is ahead, rova should catch up

| gap | rova state |
| --- | --- |
| scoped authorization dimensions, delegation, grant expiry | workspace/project only |
| IdP role mapping (`ISsoProvisioningHook`) | not bound; roles are app-assigned only |
| cross-tab refresh coordination (Web Locks) | not applicable under BFF, but the idea is opshub's |

## Not divergence — fix on sight

- `FailOpenControl` in `@quynhonsemiconductor/observability` still declares `authz_epoch` and
  `authz_epoch_bump`. Nothing emits them since #238. Removing union members is
  breaking, so they come out on the package's next major.
- Neither repo has the weekly diff gate over the shared paths yet. Until it exists,
  this register is maintained by hand, which means it will rot — the gate is what
  makes an unlisted difference *visible* rather than merely wrong.

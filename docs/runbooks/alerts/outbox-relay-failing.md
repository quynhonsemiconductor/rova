# Alert: outbox-relay-failing

An outbox relay's **pass** has thrown continuously for 10 minutes. `outbox_relay_pass_failed_total{relay}` increased in
every 3-minute window for 10 minutes (relays pass every 5 to 10 seconds, so a healthy relay adds nothing). The alert
names the relay.

## What this means

A pass dies **before it reaches a single row**: its claim query failed (a SQL error, a lost or exhausted database
connection, a schema change the query does not match). Nothing is delivered for that relay, and nothing else reports it:

- `queue_failures_total` counts ROWS that failed to deliver, and is recorded only after the claim;
- `outboxDeadLetter` (the CloudWatch alarm) needs a row to have been claimed;
- `worker-job-failure-rate` reads `job_*` metrics, and relays are not timed by them.

The `relay` label is the relay's class name: `EmailRelayService`, `NotificationRelayService`,
`EntraGuestInviteRelayService`, `AuditProjectionRelay`, `ScmWebhookRelayService` or `ScmBackfillRelayService`.

History (opshub, which shares this base class): its webhook relay's claim failed on every pass for two days with
`FOR UPDATE must specify unqualified relation names` (Drizzle renders `FOR UPDATE OF "schema"."table"` for a table in a
`pgSchema`, which Postgres rejects), so nothing was delivered, and nothing alerted. rova has no `of:` in a claim today;
a join added to a relay's claim hits the same wall on a `pgSchema` table: alias it.

## First checks

1. Which relay: Grafana Explore, `sum by (relay) (increase(outbox_relay_pass_failed_total{deployment_environment_name="<env>"}[10m]))`.
2. The error, in Loki:
   `{service_name="rova-worker", deployment_environment_name="<env>"} |= "<RelayClassName>" | detected_level="error"`
   The exception text names the cause (a Postgres error code, `ECONNREFUSED`, `too many clients`).
3. All relays or one? All of them: the database or its pool (RDS stopped, a failover, the `db-pool-contention` alert).
   One: that relay's own claim query, usually after a deploy or a migration.
4. Did it start with a deploy? The Deploys annotation on the overview dashboard.

## Escalate if

More than one relay is failing, or the error is a database connection error: that is the database, not a relay.

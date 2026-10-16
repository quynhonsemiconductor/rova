# Alert: worker-job-failure-rate

Ratio of `job_failures_total` to `job_runs_total` over 5 minutes has crossed the
environment's threshold (5% prod / 10% develop) for 5 minutes straight.

## What this means

A meaningful share of background jobs (cron jobs, email relay, Entra guest-invite
relay, notification outbox drain, audit, SCM sync) are failing — this is the worker
process (`apps/worker`), not the API.

## First checks

1. Overview dashboard, "Worker job success vs failure rate" — confirm the shape (a
   step change at a deploy vs a gradual climb).
2. Logs Explorer / Recent errors, filtered to `rova-worker` — the actual exception is
   almost always visible here; worker errors are structured the same way API errors are.
3. Check the Deploys annotation — did this start right after a deploy to the worker?
4. Check which JOB TYPE is failing (log `context` field). Different jobs have different
   likely causes:
   - Email relay: check `MAIL_FROM_EMAIL`/SES verification, SES bounce/complaint queue
     depth (see `ses-bounce-queue-*` CloudWatch alarms).
   - Entra guest-invite relay: check Graph API errors (permanent refusals vs transient).
   - Any outbox relay (email, notification, audit projection, SCM webhook and backfill, guest invite): check
     its table (`email_outbox`, `notification_outbox`, `outbox_events`, `guest_invite_outbox`,
     `scm.webhook_inbox`, `scm.backfill_jobs`) for `status = 'failed'` rows, and the `outbox-dead-letter`
     CloudWatch alarm. A row `abandoned` in `last_error` was dead-lettered because its worker died mid-call.
5. Check cache (Valkey) health — several worker paths (pub/sub, relay wake signals)
   depend on it; see the `cache-*` CloudWatch alarms.

## Likely causes, roughly in order

- Bad deploy to the worker
- A downstream dependency down or rate-limiting (SES, Microsoft Graph, GitHub)
- Cache (Valkey) unreachable, breaking pub/sub-based relay wake signals
- A DB migration or schema change the worker's queries don't yet account for

## Escalate if

Failures keep climbing and no single job type/error message dominates, or the
outbox dead-letter alarm is also firing — that combination means
delivery-critical paths (invites, notifications) are backing up, not just one flaky job.

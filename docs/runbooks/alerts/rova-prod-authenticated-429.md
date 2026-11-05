# Alert: rova-prod-authenticated-429

The live rule is `rova-prod-authenticated-429` (`infra/live/observability-alerting/rate-limit-429.tf`,
warning, 15-minute window, `no_data = OK`):

```promql
sum by (job, tier, route) (increase(rate_limit_rejected_total{
  job=~"rova/.+", deployment_environment_name="prod", keyed_by="user"
}[15m])) > 0
```

A **signed-in person** was refused with HTTP 429. The alert's own `tier` and `route` labels name
where; the guard's log line names who.

`keyed_by="address"` refusals are normally the PRE_AUTH floor doing its job and are NOT this alert.
Two exceptions: a MCP-internal call's PRE_AUTH refusal is keyed by `user` (the call token names the
person), and a `DEFAULT` refusal on a PUBLIC route has no principal, so it is keyed by `address`.
Read the tier with that in mind.

## What this means

Rova's rate limits protect against abuse; they must never shape normal work (#905). A 429 to an
authenticated user is therefore one of three things:

- a **client retry loop** — one person's SPA or integration retrying a failing request past the
  server's `Retry-After`;
- a **genuine burst far above normal use** (the measured peak was 103 requests/min for one person;
  `DEFAULT` is 1,200/min);
- **misconfiguration or a broken refund** — a signed-in request is spending the shared per-address
  PRE_AUTH bucket, or a deployment still runs an older limit. Admitted signed-in requests leave no
  PRE_AUTH slot; the ones refused by their own user tier keep it.

## First checks

1. **Which tier and route?** In Grafana:

   ```promql
   sum by (tier, route) (increase(rate_limit_rejected_total{
     job=~"rova/.+", deployment_environment_name="prod", keyed_by="user"
   }[15m]))
   ```

   Tiers and their meaning:

   | tier | ceiling (per user unless stated) | normal? |
   |---|---|---|
   | `DEFAULT` | 1,200 / 60 s | only an abnormal burst or a retry loop |
   | `STRICT` | 20 / 60 s | uploads presign and invitation emails — bulk or abusive use |
   | `PRE_AUTH` | 1,200 / 60 s per IP | abuse prevention; a signed-in request must NOT consume it. An MCP-internal refusal is keyed by `user`, because the call token names the person |
   | `PRE_AUTH_TOKEN` | 300 / 60 s per IP | token guessing; a valid token's slot is refunded after auth |
   | `DEFAULT` on a PUBLIC route | 1,200 / 60 s per IP | no principal exists, so this one is keyed `address` and is not a signed-in 429 |

2. **Who and where?** In Loki / Logs Explorer. The live rule's own text uses the pod namespace
   selector, which is the one verified against the alert (`{service_name="rova-api"}` is NOT
   confirmed here — this session had no Grafana access):

   ```logql
   {namespace="rova-prod"} |= "Rate limit exceeded"
   ```

   The line carries `userId`, `tier`, `route` (template), `ip` and the bucket `key`. Group by
   `userId` and `route`: one user and one route is a client loop; many users on `PRE_AUTH` is an
   address/refund problem.

3. **Was the request authenticated?** `keyed_by="user"` means the principal was known. A
   `PRE_AUTH:ip:` key on normal signed-in traffic means the refund did not run.

4. **Did a deploy just land?** Check the Deploys annotation. #905 changed the tiers: `v0.8.8` ran
   `DEFAULT` 100/min, `v0.8.9` raised it to 600/min, and `v0.8.10` (#905) to 1,200/min. A pod still
   on an older image produces refusals this alert will see.

5. **Check the refund path** if the tier is `PRE_AUTH`: search logs for
   `Rate limit slot not refunded`. That line means Valkey refused the refund, so every later request
   from that address keeps consuming the shared bucket. Treat it as an incident, not a limit tune.

6. **Confirm the client honours `Retry-After`.** The SPA retries a GET 429 up to twice using the
   server's wait and never shows a toast; a sustained refusal means those retries were exhausted.
   For an integration or API token, inspect its backoff.

## Likely causes, roughly in order

- A client retry loop (often one route, one user, regular spacing).
- A bulk action in the `STRICT` bucket: uploading many attachments or sending invitations, each
  limited to 20/min by design.
- A shared office/CI egress exhausting `PRE_AUTH` because refunds are failing (`valkey` errors) or a
  pod predates the refund.
- A real abnormal burst by one account — check the user's other activity before assuming abuse.

## What NOT to do

- Do **not** disable rate limiting, and do not edit a limit in production to silence the alert.
- Do **not** raise `PRE_AUTH` to make authenticated traffic fit: a signed-in request is supposed to
  leave no address slot. Fix the refund or the client instead.
- Do **not** add `userId` to a metric label. Ids belong in logs; a limit tuned from a metric must
  keep labels bounded.
- Do **not** reuse `AUTH_ME`; that tier was removed, so a series carrying it means a stale image.

## If the limit genuinely needs to change

The policy is **10x the measured peak per user, with a floor of 1,200/min for `DEFAULT`**. Measure
again from prod logs first (busiest user-minute including refusals), put the numbers in the change,
and keep tight buckets only where abuse is the threat: pre-auth per address, uploads, AI. Uploads
and invitation email stay `STRICT`; that is a product decision, not a tuning knob.

## Escalate if

- More than one user is refused at `DEFAULT` in the same window, or the same person is refused
  across different routes; or
- `PRE_AUTH` refund errors appear, or Valkey is unhealthy (fail-open also logs
  `securityFailOpen="rate_limit"`); or
- a 429 keeps occurring after the client's retry window and no deploy explains it.

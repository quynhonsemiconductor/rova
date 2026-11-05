# Alert: rate-limit-authenticated-user

A **signed-in person** was refused with HTTP 429. The counter is
`rate_limit_rejected_total{keyed_by="user"}`; the suggested rule is any increase over 5 minutes:

```promql
sum(increase(rate_limit_rejected_total{keyed_by="user"}[5m])) > 0
```

`keyed_by="address"` refusals are the PRE_AUTH floor doing its job and are not this alert: they
mean traffic that never proved who it was.

## What this means

Rova's rate limits protect against abuse; they must never shape normal work (#905). A 429 to an
authenticated user is therefore one of three things:

- a **client retry loop** — one person's SPA or integration retrying a failing request past the
  server's `Retry-After`;
- a **genuine burst far above normal use** (the measured peak was 103 requests/min for one person;
  `DEFAULT` is 1,200/min);
- **misconfiguration or a broken refund** — a signed-in request is spending the shared per-address
  PRE_AUTH bucket, or a deployment still runs an older limit.

## First checks

1. **Which tier and route?** In Grafana:

   ```promql
   sum by (tier, route) (increase(rate_limit_rejected_total{keyed_by="user"}[15m]))
   ```

   Tiers and their meaning:

   | tier | ceiling (per user unless stated) | normal? |
   |---|---|---|
   | `DEFAULT` | 1,200 / 60 s | only an abnormal burst or a retry loop |
   | `STRICT` | 20 / 60 s | uploads presign and invitation emails — bulk or abusive use |
   | `PRE_AUTH` (address) | 1,200 / 60 s per IP | abuse prevention; a signed-in request must NOT consume it |
   | `PRE_AUTH_TOKEN` (address) | 300 / 60 s per IP | token guessing; a valid token's slot is refunded after auth |

2. **Who and where?** In Loki / Logs Explorer:

   ```logql
   {service_name="rova-api"} | json | msg="Rate limit exceeded"
   ```

   The line carries `userId`, `tier`, `route` (template), `ip` and the bucket `key`. Group by
   `userId` and `route`: one user and one route is a client loop; many users on `PRE_AUTH` is an
   address/refund problem.

3. **Was the request authenticated?** `keyed_by="user"` means the principal was known. A
   `PRE_AUTH:ip:` key on normal signed-in traffic means the refund did not run.

4. **Did a deploy just land?** Check the Deploys annotation. #905 changed the tiers; a pod still on
   an older image runs the old 100/120 limits and produces refusals this alert will see.

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

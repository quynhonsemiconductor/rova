# Alert: http-slow-request-count

More than 3 HTTP requests took longer than the environment's slow line (1000ms prod /
2500ms develop) in the last 30 minutes.

## Why this exists alongside http-p99-latency

The two alerts watch the same latency and answer different questions, and at
production's current traffic only this one can answer anything.

`http-p99-latency` computes a percentile, so it needs enough samples for a percentile to
mean something — hence its volume gate, and hence its silence in production, where
measured load is single-digit requests per day. This rule computes a **count**. A count
is valid at any sample size: three slow requests are three slow requests whether the
service handled 5 requests that hour or 50,000.

So while production stays below the p99 rule's gate, **this is the HTTP latency
coverage.** Do not silence it on the grounds that the p99 rule covers the same ground —
today it does not.

## How the query works, and the one way it breaks

Prometheus histogram buckets are cumulative, so the number of requests slower than the
line is the `+Inf` bucket minus the bucket at the line:

```promql
sum(increase(http_server_duration_milliseconds_bucket{le="+Inf",   ...}[30m]))
  - sum(increase(http_server_duration_milliseconds_bucket{le="1000", ...}[30m]))
```

The `le` value is matched as a **string label**, so it must be one of the boundaries the
service actually exports. A plausible-looking number that is not a real boundary — 2000,
1500, 3000 — matches no series at all, the subtraction returns an empty result, and the
rule reports OK forever while looking like coverage. `terraform_data.slow_request_bucket_is_real`
in `infra/modules/stack/main.tf` fails the plan rather than letting that pass review, and
`local.http_duration_boundaries_ms` in the same file is the list of legal values. That
list mirrors `apps/api/src/main.ts`; if one moves, both move.

## First checks

1. **Find the actual requests.** This alert gives a count, not a duration or a route.
   Logs Explorer for the window, filtered on the API service, sorted by `duration` —
   the access log carries `duration`, `albWaitMs` and `bodyWaitMs` per request, which
   splits "the app was slow" from "the request was held before the app saw it".
2. **Check whether they cluster on one route.** A single slow route is a query or a
   downstream call; slow requests spread across every route are the process or the
   database.
3. **Check whether they cluster in time.** Three slow requests inside one minute after a
   deploy is almost certainly the cold start described below, not a regression. Three
   spread evenly across 30 minutes is a real pattern.
4. Runtime & Dependencies dashboard, "DB client operation latency (p99, by operation)"
   and "DB client connections: by state, vs pending".
5. "Outbound HTTP client calls: rate + p99 latency" — a slow SES, GitHub or Cloudflare
   call blocks the request handling it.

## Likely causes, roughly in order

- **A cold start after a task replacement.** `api.min_count` is 1 at 256 CPU units, so
  every deploy replaces the single task, and the ALB target group health-checks
  `/v1/healthz`, which returns 200 without touching a dependency. The replacement is
  therefore admitted to live traffic before its connection pool is warm. The pool is now
  pre-warmed in `DrizzleProvider.onModuleInit` (see `DATABASE_POOL_MIN`), which is what
  this cause used to look like before that landed — if it reappears, check whether the
  warm-up is logging a failure rather than succeeding.
- **A slow query, or one that used to be fast on a smaller table.**
- **RDS CPU credit exhaustion.** Production runs `db.t4g.micro`, which is burstable and
  degrades into throttling rather than failing. `<name>-rds-cpu-credit-low` alarms on
  this directly; check it for the same window.
- **A downstream call with a large timeout budget.** Note that these requests usually
  **succeed**, so the 5xx rate alert will not corroborate. A request that spends its
  whole retry budget and then answers 2xx or 4xx is exactly the shape this rule catches
  and that one cannot.
- Event loop blocked by synchronous or CPU-heavy work on the request path.

## Escalate if

The count keeps climbing across consecutive windows, or the slow requests cannot be
attributed to a route or a dependency within 20 minutes. A sustained count is the
early form of the outage `http-5xx-rate` would report later.

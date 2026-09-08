# Alert: http-p99-latency

p99 of `http_server_duration_milliseconds` has stayed above the environment's
threshold (1000ms prod / 2000ms develop) for 5 minutes straight, in a 5-minute window
that held at least the environment's minimum request count (50 prod / 20 develop).

## Read the number before you act on it

Two things about this alert's value are not obvious from the notification, and both
have already sent someone down the wrong path:

- **A value of exactly `10000` is not a latency measurement.** 10000ms is the largest
  finite bucket boundary of the OpenTelemetry JS default histogram, so
  `histogram_quantile` cannot report anything higher and clamps there. `A=10000` means
  "at least one request took longer than 10 seconds, and the histogram cannot say how
  much longer" — the real value could be 11 seconds or 4 minutes. Do not read it as
  "the p99 was ten seconds", and do not treat a drop from 10000 to a two-digit number
  as a large improvement: it usually just means the slow request aged out of the
  window. To find the actual duration, go to the traces or to the request log for the
  window, not to this metric.
- **This rule is volume-gated, so silence is not the same as health.** The query only
  evaluates when the 5-minute window holds at least 50 requests in production or 20 in
  develop. Below that floor the rule reports no data, which Grafana renders as OK. That
  state means "not enough samples to compute a percentile", NOT "latency is fine".
  Production's measured load is single-digit requests per day, so this is the NORMAL
  state in production today, not an exception.

  The gate exists because a percentile over a handful of samples is not a percentile. A
  5-minute window holding one real request makes the p99 of that window equal to that
  one request, and the alert then fires and clears on individual requests. The same
  defect was found and fixed on the CloudWatch side first — see the `alb_latency` alarm
  in `tf-modules//modules/observability`, which gained the identical gate at the
  same floor of 50.

  The coverage that survives below the gate is **`http-slow-request-count`**, which
  counts requests over the slow line instead of computing a percentile of them. If you
  want to know whether production is slow at current traffic, that is the alert to look
  at; this one cannot tell you.

## What this means

The slowest 1% of requests are slow enough to matter — this fires independent of the
error rate, so the request usually still succeeds, just late.

## First checks

1. Overview dashboard, "HTTP p50/p95/p99 latency" — is it all three percentiles moving,
   or just p99 (a few genuinely slow requests vs the whole service degrading)? At low
   traffic, check the request-count panel in the same window first: if the window held
   two requests, the shape of the percentile line carries no information.
2. Runtime & Dependencies dashboard, "DB client operation latency (p99, by operation)" —
   a slow SELECT/INSERT/UPDATE is the most common root cause.
3. Same dashboard, "DB client connections: by state, vs pending" — pending connections
   queueing for the pool adds straight to request latency.
4. "Outbound HTTP client calls: rate + p99 latency" — a slow downstream (SES, GitHub,
   Cloudflare) blocks the request handling it.
5. "Node.js event loop lag" — if this is elevated, the process itself is CPU-starved,
   not waiting on I/O; check ECS CPU (CloudWatch) for the same window.
6. Check the Deploys annotation line. See the cold-start cause below — at production's
   task count, a deploy is a genuine and expected source of a handful of slow requests.
7. Check the two burstable-RDS alarms, `rally-<env>-rds-cpu-credit-low` and
   `rally-<env>-rds-freeable-memory-low`. Production runs `db.t4g.micro`, which does not
   fail when it runs out of headroom, it gets slower: an exhausted CPU credit balance
   pins the instance at its 10% baseline while `CPUUtilization` still reads as healthy,
   and application p99 latency is the first place that shows up.

## Likely causes, roughly in order

- **Cold start after a deploy or a task replacement.** Production runs `api.min_count = 1`
  at 256 CPU units, so every deploy replaces the single task, and there is no warm
  second task to absorb requests while the new one starts. The ALB target group health
  check is `/v1/healthz`, which returns 200 without touching Postgres or Valkey (that is
  `/v1/readyz`, deliberately — see the note above `health_check_path` in
  `infra/modules/stack/main.tf`). So the target is declared healthy and admitted to live
  traffic with an empty connection pool, an unwarmed JIT and no cached DNS: the first
  requests it serves pay for opening a Postgres connection, a Valkey connection and
  whatever else the path touches. At production's traffic level "the first few requests
  after a deploy" can be most of the requests in the window, which is why this cause is
  listed first rather than last.
- A missing index or a query that used to be fast on a smaller table
- DB connection pool undersized for current concurrency (see db-pool-contention.md)
- RDS running out of burst headroom — CPU credits exhausted, or FreeableMemory falling
  so that reads Postgres used to serve from its filesystem cache start hitting EBS
- A downstream call with no timeout, or a timeout set too high
- Event loop blocked by synchronous/CPU-heavy work on the request path

## Escalate if

Latency keeps degrading and a specific slow query/operation can't be identified within
20 minutes, or ECS CPU is pinned near 100%.

Do NOT escalate on a single `A=10000` datapoint that has already resolved, and do not
escalate on this alert going quiet. Correlate with `http-slow-request-count` first: if
that rule is not firing, fewer than four requests crossed the slow line in the last half
hour and there is nothing here that needs a human out of bed.

# Observability Architecture — Current State

Date: 2026-08-30 · Status: **live in develop, pending prod apply** · Scope: rova only (opshub/qnsc-kb-backend replication not started)

Supersedes `2026-07-26-observability-architecture-design.md` for anything the two disagree
on. That document is the original plan; this one is what actually shipped, verified against
real Grafana screenshots and live queries, not reconstructed from Terraform alone.

## 1. Two sources, deliberately, not one

| | Grafana Cloud | AWS CloudWatch |
|---|---|---|
| Covers | Everything app-emitted: HTTP/DB-pool/worker metrics, logs, traces | Everything AWS-native: RDS, ECS, ALB, ElastiCache, SQS |
| Why here | Only place this data exists — our own OTel instrumentation | Free, published by AWS regardless of anything we do |
| Notifies via | Microsoft Teams (webhook) | Email (SNS topic, `alarm_emails`) |
| Managed by | `rova/infra/modules/stack` + `qnsc-infra/live/observability` (Terraform) | `rova/infra/modules/stack` + `qnsc-tf-modules/modules/observability` (Terraform) |

**Not merged, on purpose.** Ingesting CloudWatch metrics into Grafana's Mimir would spend
metered free-tier series budget (10k cap) on data that is free in CloudWatch and already
alarmed independently — the anti-pattern, not an oversight. A CloudWatch datasource in
Grafana for VIEWING (live-proxied, not ingested) is a near-zero-cost option if a combined
dashboard screen is ever wanted; not built, because nothing asked for it and alarm routing
would stay split either way.

This reverses the earlier design doc's plan (CloudWatch Logs + a Grafana CloudWatch
datasource for one pane of glass) — see that document's superseded-notice for why.

## 2. Grafana Cloud side

**Stack**: one shared Grafana Cloud stack (`qnsc`, `qnsc-infra/live/observability`), free
tier — 10k active series, 50GB logs+traces+profiles combined, 14-day retention. Multi-tenant
by resource attribute (`service_namespace` = product, `deployment_environment_name` = env),
not by separate stacks.

**Ingestion**: `qnsc-tf-modules/modules/observability-agent`, a per-task OTel Collector
sidecar in every ECS task (api, worker), pushing OTLP/HTTP outbound over NAT egress. Gated
on `otlp_endpoint` being set — live in both develop and prod. Logs take a SEPARATE path:
`firelens-agent` (Fluent Bit) ships container stdout straight to Loki, not through the OTel
collector — deliberately a different pipeline, see that module's own README.

**Metrics** (`libs/platform`'s `@quynhonsemiconductor/observability`): `http_server_requests_total`,
`http_server_errors_total`, `http_server_duration_milliseconds_bucket`, `db_pool_in_use`,
`db_pool_waiting`, `db_client_operation_duration_seconds_bucket`, `db_client_connection_count`,
`job_runs_total`, `job_failures_total`, `v8js_memory_heap_used_bytes`, Node.js event loop lag.
Real Mimir label names confirmed by direct query, not guessed: `route`, `status_class` on
HTTP metrics; `net_peer_name`, `http_status_code` on outbound calls; `db_operation_name`;
`db_client_connection_state` (idle/used).

**Logs**: Loki, indexed labels `service_name`, `service_namespace`,
`deployment_environment_name`, `detected_level`. Every log line also carries `trace_id`,
`span_id` in its JSON body (not indexed — searched via `| json` in LogQL).

**Traces**: Tempo. Log→trace correlation works via Loki `derivedFields` — Grafana Cloud
auto-provisions this on the Loki datasource (confirmed live: expanding any log line with a
`trace_id` shows a clickable `traceID` link under "Show log details" → Links, opening the
real trace waterfall in Explore). Not something this repo's Terraform configures — the
Loki datasource is `"readOnly": true` via the API, confirmed by direct query, so it could
never have been Terraform-managed anyway.

**Dashboards** (`rova/infra/modules/stack/main.tf`, one Terraform-provisioned dashboard
per concern, RED/USE split):
- **Overview** — HTTP request rate/error rate/status distribution/latency (p50/p95/p99),
  DB pool in-use vs waiting, worker job success/failure rate, Recent errors (fixed-query
  logs panel), Logs Explorer (freetext-searchable, `$level` template variable, all
  severities), a "Search traces (Tempo Explore)" dashboard link (not an embedded panel —
  no verified real JSON shape exists for a sortable multi-trace panel, checked via GitHub
  code search, zero real fixtures found), deploy annotations.
- **Runtime & Dependencies** — DB client op latency by operation, DB connections by state,
  outbound HTTP client calls, queue processed rate/lag, Node event loop lag, V8 heap, log
  volume (Loki `count_over_time`, metric-via-logs), deploy annotations.
- **System Overview** (`qnsc-infra/live/observability`) — cross-product HTTP rate/error
  rate/p99 latency by `(service_namespace, deployment_environment_name)`, active Mimir
  series count (stack-wide, all products).

**Alerting** (`qnsc-tf-modules/modules/observability-alerts`, Grafana's native alerting,
Teams contact point + one root notification policy grouped by
`alertname, product, env`):

| Rule | Threshold (develop / prod) | Runbook |
|---|---|---|
| `http-5xx-rate` | 5% / 2% | `docs/runbooks/alerts/http-5xx-rate.md` |
| `http-p99-latency` | 2000ms / 1000ms | `docs/runbooks/alerts/http-p99-latency.md` |
| `db-pool-contention` | any waiting connection | `docs/runbooks/alerts/db-pool-contention.md` |
| `worker-job-failure-rate` | 10% / 5% | `docs/runbooks/alerts/worker-job-failure-rate.md` |

Every rule annotation carries a `runbook_url` (Grafana renders it as a clickable link on
the fired alert). Thresholds are per-env (`local.alert_thresholds_by_env`), the SAME
numbers the dashboard threshold-line overlays draw — single source of truth, cannot drift.

**SLO** (`grafana_slo`, `rova/infra/modules/stack/main.tf`) — HTTP availability, ratio of
non-5xx to total requests, 30-day rolling window, 99% develop / 99.5% production. A
DIFFERENT question from `http-5xx-rate` (5-minute page-worthy vs 30-day commitment),
deliberately a separate objective number. Generates its own fast-burn/slow-burn alert
rules from the error budget, routed through the same Teams contact point.

**Stack-wide usage alert** (`qnsc-infra/live/observability`) — `grafana_rule_group` firing
at 8000 active series (80% of the 10k free-tier cap), reusing the exact PromQL the System
Overview "Active Mimir series" panel already displays. Built this way because Grafana
Cloud's own Cost Management/Usage Alerts feature has no Terraform resource (checked the
provider source directly) — this is the IaC-manageable substitute for series count.
**Logs/traces GB does NOT have an equivalent** — no Mimir-exposed metric for ingested GB
exists; that threshold is set by hand in Cost Management and Billing → Usage Alerts
(~40 GiB), the one genuinely UI-only step in this whole design.

## 3. CloudWatch side

All via `qnsc-tf-modules/modules/observability` (RDS/ECS/ALB/cache), one raw
`aws_route53_health_check`/`aws_cloudwatch_metric_alarm` per product-specific resource, and
one shared SNS topic (`alarm_emails`):

| Resource | Alarms | Notes |
|---|---|---|
| RDS | CPU, free storage, connections | Plus Performance Insights + Enhanced Monitoring for ad-hoc deep-dives (not alarmed, viewed manually) |
| ECS (api, worker) | CPU, memory | Per service |
| ALB | 5xx count, p95 latency (per target group, not load-balancer-wide — the ALB is shared with opshub), UnHealthyHostCount | Suppressed together when an environment is deliberately idle (`environment_idle`) |
| ElastiCache (cache, node mode only) | CPU, free memory, any eviction | Not wired for prod's dedicated node's sibling — a SHARED cache node (develop) deliberately has none, see below |
| SQS (`ses_bounce_feedback`) | Queue depth (>100), oldest-message age (>1h) | Catches `BounceFeedbackService`'s poller stalling — a compliance-relevant silent failure otherwise |
| Route 53 health check | `api_ingress_down` — probes `rally-api.qnsc.vn/v1/healthz` from outside AWS every 30s | Prod-only, replaces the ALB target-health alarm since prod has no ALB (Cloudflare Tunnel ingress). ~$2.70/mo. The only thing that would notice the tunnel itself dying |
| App-specific | `security_fail_open` (auth denylist/rate-limiter degraded), `outbox_dead_letter` | Log-metric-filter-based, not OTel — deliberate, since `OTEL_ENABLED` being on doesn't change that CloudWatch already has these logs regardless |

**Deliberately NOT alarmed on a shared resource.** ElastiCache CloudWatch alarms are only
wired when a product has its OWN dedicated node (`cache.shared = false`, true for rova
prod). Rova develop uses a SHARED node (`qnsc-infra/live/runtime-dev`,
`module.shared_cache`) — an alarm scoped to one tenant of a multi-tenant resource would
misattribute, the same class of bug the ALB latency alarm avoided by scoping per target
group instead of per load balancer. A shared node's alarms belong where the node is
created, not in one tenant's stack — not yet built there, tracked as a follow-up.

## 4. What is genuinely not built, and why

- **Embedded multi-trace search panel** — no verified real JSON shape exists for a
  sortable TraceQL table panel in a Grafana dashboard. A dashboard LINK to Tempo Explore
  substitutes; not a guessed panel.
- **Logs/traces GB usage alert** — no Terraform resource for Grafana Cloud's Cost
  Management feature exists. One manual UI toggle, the only one in this design.
- **Shared cache node alarms (develop)** — belongs in `qnsc-infra`, not built yet.
- **Cross-product replication** (opshub, qnsc-kb-backend) — same shared Grafana stack,
  none of firelens-agent/observability-agent/observability-alerts/dashboards/SLO built
  for either product yet.

## 5. What is NOT true anymore, if you're reading an older doc

The 2026-07-26 design doc's plan — CloudWatch Logs + a Grafana CloudWatch datasource as
the single pane of glass, logs never touching Loki directly — was superseded during
implementation. `libs/platform`'s observability CLAUDE.md section used to say
`OTEL_ENABLED is false everywhere and no collector exists` — also no longer true, fixed
2026-08-30. If a document says either of those things, it predates this one.

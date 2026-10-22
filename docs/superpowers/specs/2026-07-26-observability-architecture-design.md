# Observability Architecture — Design

Date: 2026-07-26 · Status: **SUPERSEDED — see `2026-08-30-observability-architecture-current-state.md`** · Scope: **platform-wide** (rova, opshub, and every product after them)
Author role: solution architect. Supersedes the observability sections of `RALLY_HARDENING_PLAN.md` (R9) and `OPSHUB_RALLY_PARITY_PLAN.md` (P2-1).

**This document describes the ORIGINAL plan, not what was actually built.** Two decisions
below were reversed during implementation: app logs go directly to Loki via FireLens
(`firelens-agent`), not through CloudWatch Logs + a Grafana CloudWatch datasource (§4/§5
below); and CloudWatch stayed alarm-only for AWS-native infra metrics (RDS/ECS/ALB/cache/
SQS), with no CloudWatch datasource wired into Grafana at all — a genuinely two-source
design (Grafana for app signals, CloudWatch console for infra alarms), not the
one-pane-via-CloudWatch-datasource plan this document proposes. Read this only for the
original reasoning/cost analysis; read the other document for what is actually live.

---

## 1. Why this document exists

Rova has a complete OpenTelemetry implementation that reports nothing, and a logging implementation that is genuinely good but copy-pasted. OpsHub is about to inherit both. Before that happens, the company needs one answer to "how do we see what our systems are doing" that holds for the next several products.

### 1.1 Verified current state (rova @ `7c258d9`)

| Pillar | Evidence | State |
|---|---|---|
| Logs | pino + redaction + `trace.id`/`span.id` + ALS context (`workspaceId`, `userId`, `correlationId`), 7d dev / 90d prod retention | **Good** — the one working pillar |
| Traces | `apps/api/src/otel.ts`, `apps/worker/src/otel.ts`, 45 `@Span()` call sites, auto-instrumentation for HTTP/pg/redis/AWS | **Inert** |
| Metrics | `OTEL_METRICS` (23 names), `BaseMetrics` abstract class | **Absent** — zero references to either |
| Enablement | `OTEL_ENABLED=false` in `infra/live/develop/main.tf:346,474`, `prod:327,451`, `.env:48`. No OTLP endpoint, no collector anywhere | **Off everywhere** |

### 1.2 Defects to fix on the way

1. **Worker logging config duplicates the API's, minus `redact`** (`apps/worker/src/worker.module.ts:28-64`). Latent credential leak via logged SDK error objects.
2. **`req.user?.id` never resolves** (`http-logging.interceptor.ts:99,132`) — the principal exposes `sub`. Dead field; the pino `mixin` covers it via ALS.
3. **Worker jobs have no ALS context.** `requestContextStorage.run` is only called by the HTTP middleware, so cron/outbox/consumer logs carry no `correlationId` or `workspaceId`.
4. **No trace context through the queue.** No `traceparent` in outbox messages → async traces would break at the boundary even with OTel on.
5. **`otel.ts` duplicated across two apps** (43 diff lines, differing only in service name).
6. **Head sampling discards the traces you need.** Prod is `ParentBased(TraceIdRatio(0.1))` — 90% dropped *including every error*.
7. **`SERVICE_VERSION` is never set in infra** (defaults to `'dev'`), so no signal is attributable to a release.
8. **Comment/code mismatch:** two comments claim health probes are sampled at 1%; the code skips them entirely, and skips only `/v1/healthz`, not `/v1/readyz`.
9. **No dashboards, no alarms, no SLOs** anywhere in either repo.

---

## 2. Principles

These are the decisions everything else follows from.

**P1 — Own the collector and the conventions; rent the storage.**
The application is already OTLP-native, so the backend is a rental decision. Switching vendors must mean editing one exporter block — never touching application code. The durable company assets are the instrumentation package, the semantic conventions, and the collector config.

**P2 — One platform, split by environment, isolated by label and token.**
Not one stack per product: that multiplies cost and ops and destroys cross-product correlation exactly when a shared dependency (RDS, ElastiCache, the ECS cluster) is the suspect. Products are separated *inside* the platform.

**P3 — Instrumentation is inherited, not written.**
A new endpoint, service, or job gets logs, traces, and RED metrics with **zero** added code. Anything a developer must remember will be forgotten in some service, and the gap will be invisible.

**P4 — IDs never become metric labels.**
`workspaceId`/`userId`/`projectId` belong on spans and logs. One id in a Prometheus label is unbounded cardinality — the single most common cause of both observability outages and surprise bills.

**P5 — Sampling decisions live in the collector.**
Keeping 100% of errors must not require an application redeploy.

**P6 — Two retention tiers.**
Fast interactive querying is a different product from compliance archive. Paying vendor rates for 90-day retention when CloudWatch already holds it is waste.

**P7 — Prefer the boring, reversible option until a measured trigger fires.**
No self-hosting to avoid a bill that hasn't arrived.

---

## 3. Target architecture

```
┌────────────────────────── ECS task (per service) ───────────────────────────┐
│                                                                             │
│  app container (rally-api | rally-worker | opshub-api | …)                   │
│    @quynhonsemiconductor/observability                                                    │
│      ├─ otel bootstrap  ── OTLP/HTTP ──▶ localhost:4318 ┐                    │
│      ├─ pino logger (redaction, mixin)  ── stdout ──────┼──▶ awslogs driver  │
│      ├─ ALS context (http middleware + job wrapper)     │                    │
│      └─ metrics registry (RED/USE helpers)              │                    │
│                                                          ▼                   │
│  otel-collector sidecar   batch · memory_limiter · resource · filter        │
│                           per-product token, per-product volume cap          │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ OTLP/HTTP + TLS
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
        ┌───────────────────────┐        ┌─────────────────────────┐
        │  Grafana Cloud        │        │  CloudWatch Logs        │
        │  (traces + metrics)   │        │  (compliance archive)   │
        │  14d interactive      │        │  7d dev / 90d prod      │
        │  prod stack + nonprod │        │  queried via Grafana    │
        └───────────────────────┘        └─────────────────────────┘

Phase 3 addition, only when tail sampling is needed:
        sidecars ──▶ collector-gateway ECS service (routes by trace ID) ──▶ backend
```

### 3.1 Code layer — one shared package

**`@quynhonsemiconductor/observability`**, published alongside the existing `@quynhonsemiconductor/{identity,platform-cache,platform-http}`. This is what makes the pattern DRY across *repos*, not merely within one.

| Export | Replaces | Notes |
|---|---|---|
| `bootstrapOtel({ serviceName, version, env })` | `apps/api/src/otel.ts` + `apps/worker/src/otel.ts` | One implementation; service name is a parameter, not a fork |
| `createLoggerOptions(config, { serviceName })` | both `LoggerModule.forRootAsync` blocks | Redaction is **inside** the factory, so a consumer cannot forget it (defect 1) |
| `RequestContextService`, `AlsMiddleware`, `withJobContext()` | `libs/platform/src/context/*` | `withJobContext` closes defect 3 for cron/outbox/consumers |
| `@Span()`, `startSpan()` | `libs/platform/src/observability/span.decorator.ts` | Unchanged semantics; 45 existing call sites keep working |
| `MetricsRegistry` + `httpMetrics`, `dbMetrics`, `queueMetrics` | `BaseMetrics` + `OTEL_METRICS` | Typed names, **implemented** — not declared and abandoned |
| `HttpLoggingInterceptor` | `libs/platform/src/http/http-logging.interceptor.ts` | Also emits HTTP RED metrics; drops the dead `req.user?.id` (defect 2) |
| `HealthController` | `libs/platform/src/observability/health.controller.ts` | Unchanged |
| `propagateTraceContext()` / `extractTraceContext()` | new | `traceparent` in/out of outbox rows (defect 4) |

Each product's `PlatformModule` imports the package and passes its own service name. Nothing else.

### 3.2 What a developer gets for free (P3)

| Surface | Logs | Traces | Metrics | Developer action |
|---|---|---|---|---|
| HTTP endpoint (any controller) | request line + context | server span + auto pg/redis/http children | `http.server.duration`, `.requests`, `.errors` | **none** |
| DB query | on error | auto pg span | `db.client.duration` | **none** |
| Cache / S3 / SNS / SQS call | on error | auto span | client duration | **none** |
| Cron job | job start/end + `correlationId` | job span | `job.duration`, `job.runs`, `job.failures` | wrap handler in `withJobContext('name')` — **one line** |
| Outbox relay / SQS consumer | per batch | span **linked to the producing request** | `queue.lag`, `queue.processed`, `queue.failures` | **none** (inside the shared relay base class) |
| Domain service method | — | child span | — | `@Span()` — **one decorator**, optional |
| Business event (invite sent, iteration closed) | — | — | `MetricsRegistry.counter(...)` | **one line**, deliberate |

The important column is the last one. Everything a *reviewer* would notice missing is automatic.

### 3.3 Signal conventions

Resource attributes on **every** signal from **every** service:

```
service.namespace      = qnsc
service.name           = rally-api | rally-worker | opshub-api | …
service.version        = <release tag>          ← from CI, fixes defect 7
service.instance.id    = <task id>
deployment.environment = develop | prod
```

| Rule | Rationale |
|---|---|
| Metric labels: only bounded, low-cardinality values (`route` template, `method`, `status_class`, `tier`, `outcome`) | P4 |
| Never as labels: any id, email, URL with parameters, raw `status_code` at high cardinality | P4 |
| Custom span/log attributes namespaced: `rally.workspace.id`, `rally.project.id`; plus semconv `enduser.id` | Cross-product queries stay possible; Grafana's built-ins keep working |
| Route templates, never raw paths (`/v1/work-items/:id`, not `/v1/work-items/019f…`) | A raw path in a label is unbounded cardinality wearing a disguise |
| Log levels: `error` = paged, `warn` = investigated, `info` = business events + request lines, `debug` = off in prod | Keeps volume and noise predictable |
| **No PII in any signal**: no emails, names, tokens, or request bodies on spans or metrics. IDs only. The pino `redact` list covers headers; span attributes have no equivalent safety net, so this is a review rule | Telemetry leaves our AWS account — it must not carry personal data |
| Telemetry region pinned to the closest Grafana Cloud region and recorded in §9 | Latency, and a documented answer to "where does our data go" |

### 3.4 Metric catalogue (implement these, delete the rest)

**RED per service** — from the HTTP interceptor and the job/queue wrappers:

| Metric | Type | Labels |
|---|---|---|
| `http.server.duration` | histogram | `route`, `method`, `status_class` |
| `http.server.requests` | counter | `route`, `method`, `status_class` |
| `http.server.errors` | counter | `route`, `error_code` |
| `job.duration` / `job.runs` / `job.failures` | histogram / counter | `job` |
| `queue.lag_seconds` / `queue.processed` / `queue.failures` | gauge / counter | `queue` |

**USE per resource:**

| Metric | Source |
|---|---|
| `db.client.duration`, `db.pool.in_use`, `db.pool.waiting` | pg instrumentation + pool gauge |
| `cache.operation.duration`, `cache.errors` | redis instrumentation |
| RDS/ElastiCache/ALB/ECS CPU, memory, connections | CloudWatch datasource — no app code |

**Security/reliability counters** (this is where R9 lands permanently):

| Metric | Meaning |
|---|---|
| `security.fail_open` | denylist or rate limiter degraded — **page** |
| `authz.stale_token` | tokens rejected by the authorization epoch |
| `auth.login.failures` | brute-force signal |

Every `OTEL_METRICS` name not in the tables above gets **deleted**. Half-declared metrics are worse than none: they imply coverage that doesn't exist.

### 3.5 Collector layer

**Now — sidecar per task.** The shared `ecs-service` module already accepts `additional_containers` (opshub uses it for a Valkey sidecar), so this needs **no module change**. Processors: `memory_limiter`, `batch`, `resource` (inject the attributes in §3.3), `filter` (drop health probes and static assets), `transform` (strip debug attributes in prod).

**Phase 3 — add a gateway** when tail sampling is wanted. This is a constraint, not a preference: a tail sampler must see every span of a trace, and a sidecar only ever sees its own fragment. The pattern is agents → load-balancing gateway (routes by trace ID) → sampler → backend.

**Sampling policy** (fixes defect 6):

| Trace | Kept |
|---|---|
| any error span | 100% |
| latency > p95 threshold | 100% |
| health probes / static assets | 0% (dropped at the sidecar, no span created) |
| everything else | 5–10% |

Until the gateway exists, keep head sampling at **100% in develop** and 10% in prod, and accept that prod error traces are lossy — that is precisely the gap Phase 3 closes.

### 3.6 Logs on ECS — the one awkward path

A sidecar collector **cannot read another container's stdout** on ECS; that requires a log router, and the shared module hardcodes `logDriver = "awslogs"`.

| Phase | Path | Why |
|---|---|---|
| Now | app → stdout → `awslogs` → CloudWatch → **Grafana CloudWatch datasource** | Zero infra change. Keeps the 90-day SOC 2 retention already in place. `trace.id` is already on every line, so log→trace jumps work on day one |
| Later (optional) | app → stdout → **FireLens/Fluent Bit sidecar** → Loki | Better querying and cheaper at volume. Requires adding `awsfirelens` support to the shared `ecs-service` module — one module release, every product inherits it |

Do **not** route logs through the OTLP collector to get "one pipeline". It buys nothing here and gives up the CloudWatch archive.

### 3.7 Backend and tenancy

**Grafana Cloud, two stacks:**

```
qnsc-observability-prod      ← rally-prod, opshub-prod, future products
qnsc-observability-nonprod   ← rally-develop, opshub-develop
```

Split by **environment, not product** (P2). Inside each stack:

- **Ingest tokens per product** — rova's token cannot write or read opshub's data
- **Dashboard folders per product**, plus shared platform dashboards (RDS, cache, ALB, ECS)
- **Alert routing per product** to that product's channel
- **Cost attribution** by `service.name` / `service.namespace`

Free tier covers **both products**: 10k active series, 50 GB logs, 50 GB traces, 14-day retention, 3 users.

### 3.8 What stays in AWS, and what does not

The first question a reviewer asks. This is a hybrid, not a migration off AWS.

| Signal / concern | Stored in | Queried from |
|---|---|---|
| App logs | **CloudWatch Logs** (existing `awslogs` driver) | Grafana, CloudWatch datasource |
| AWS infra metrics (RDS, ElastiCache, ALB, ECS) | **CloudWatch Metrics** | Grafana, same datasource |
| App metrics (HTTP RED, job/queue, DB pool) | Grafana Cloud | Grafana |
| Traces | Grafana Cloud (Tempo) | Grafana |
| Fail-open alarm (interim, R9) | **CloudWatch** metric filter + alarm + SNS | CloudWatch → Grafana from Phase 3 |
| Ingest token | **AWS Secrets Manager** | — |

**Dropped deliberately:**

| Service | Why not |
|---|---|
| **X-Ray** | AWS has put the X-Ray SDKs and daemon into maintenance mode in favour of OpenTelemetry; ~$150/mo at 10M traces; no tail sampling; splits traces away from logs and metrics |
| **Amazon Managed Prometheus** | ~$81+/mo for even a modest scrape, before queries |
| **Amazon Managed Grafana** | $9/editor + $5/viewer for a worse-configured version of the free tier |
| **CloudWatch custom app metrics (EMF)** | Billed per metric; high cardinality gets expensive fast. App metrics go OTLP → Grafana instead |

Logs deliberately stay in CloudWatch: it already works, already holds the 90-day SOC 2 retention, and moving them would need a FireLens sidecar **plus** a shared-module change — to replace something free with something billed.

### 3.9 Retention tiers (P6)

| Tier | Where | Retention | Cost |
|---|---|---|---|
| Interactive | Grafana Cloud | 14 days | $0 on free tier |
| Compliance archive | CloudWatch Logs (already provisioned) | 7d dev / 90d prod | already paid |
| Cold (only if needed) | S3 export, Parquet | years | cents/GB |

### 3.10 Frontend and edge — scoped, not forgotten

Everything above covers the backend. Two surfaces are **not** covered by it, and pretending otherwise would leave the same kind of gap this document exists to close.

| Surface | Today | Plan |
|---|---|---|
| React SPA (`apps/web`) | nothing — no JS error capture, no web vitals, no user-facing latency data | **Phase 5.** Grafana Faro (included in the free tier) — JS errors, web vitals, and `traceparent` propagation so a browser action links to its API trace |
| Cloudflare Pages Function (the BFF proxy) | nothing — Cloudflare's own logs only | **Phase 5.** Workers Logpush → CloudWatch or OTLP. Low priority: the proxy is thin, and its failures surface as API-side errors |
| Migrator one-shot task | CloudWatch logs only | Sufficient. It is a batch job; the deploy workflow already gates on its exit code |
| Uptime / synthetic checks | none | **Phase 5.** Free tier includes synthetics — one check per public endpoint per env, as the outside-in signal that no internal metric can give you |

The SPA gap is the biggest blind spot in the current system: a user-visible JS crash produces **no signal at all** today. Deliberately deferred to keep Phases 0–4 shippable, not dismissed.

---

## 4. Ownership map (the DRY answer)

| Concern | Owner | Consumed by |
|---|---|---|
| SDK bootstrap, logger factory, ALS, span decorator, metrics registry, conventions | **`@quynhonsemiconductor/observability`** (npm) | every product's `PlatformModule` |
| Collector sidecar container + config + IAM + token wiring | **`qnsc-tf-modules//modules/observability-agent`** (new) | every product's `infra/live/*` |
| `awsfirelens` log-driver option | **`qnsc-tf-modules//modules/ecs-service`** (existing, Phase 4) | every product |
| `SERVICE_VERSION` / `OTEL_RESOURCE_ATTRIBUTES` from the release tag | **`qnsc-ci`** deploy action | every product |
| Grafana stacks, tokens, dashboards-as-code, alert rules | **platform repo** (new, or `qnsc-infra`) | shared |
| Product-specific dashboards and alert thresholds | the product repo | itself |

A product's observability config becomes a module version bump plus a service name. That is the test of whether this is DRY: onboarding product #3 should be a pull request, not a project.

---

## 5. Performance and scale envelope

| Concern | Design answer |
|---|---|
| App overhead | Batch span processor (already configured: 200 spans / 2 s in prod). OTLP export is async and off the request path |
| Sidecar cost | ~128 MB / 0.1 vCPU per task. On Fargate this is a small bump in task size, not a new task |
| Backpressure | `memory_limiter` in the sidecar; the SDK drops spans rather than blocking the app. Losing telemetry must never cause an outage |
| Cardinality | Bounded by §3.3 label rules; enforced by review + a lint-style test asserting no id-shaped label keys |
| Volume growth | Sidecar-level volume caps per product prevent one product exhausting a shared quota (noisy-neighbour) |
| Trace continuity | `traceparent` on outbox rows and SNS/SQS message attributes → API span and worker span join in one trace |
| Query performance | 14-day interactive tier stays small; heavy historical queries go to the archive tier, not the hot store |

Realistic combined volume for rova + opshub today: **2–10 GB logs/month, 1–5 GB traces/month, 2–5k active series** — comfortably inside the free tier, with room for a third product.

---

## 6. Cost model

| Option | Monthly | Verdict |
|---|---|---|
| **Grafana Cloud Free** (10k series, 50 GB logs, 50 GB traces, 14d, 3 users) | **$0** | **Chosen** |
| Grafana Cloud Pro | $19 + $6.50/1k series + ~$0.45/GB | Upgrade path; metrics cardinality is the risk |
| SigNoz Cloud | $49 min, $0.30/GB | Cheaper per GB if log-heavy; single pane |
| SigNoz / OpenObserve self-hosted | ~$100–300 infra + ops time | Right answer **at volume**; OpenObserve is a single binary on S3/Parquet, free ≤50 GB/day |
| AWS native (AMP + AMG + X-Ray) | AMG $9/editor + $5/viewer; AMP ~$81+; X-Ray ~$150 at 10M traces | **Rejected** — most expensive, weakest UX, X-Ray SDKs are in maintenance mode |

| Datadog / New Relic | ~$15–23 per host per month + per-GB logs | **Rejected** — best-in-class UX, but 2 products × 2 envs × 2 services makes it the most expensive option by an order of magnitude, for tooling no better than OTel + Grafana at this scale |

**The cost that dominates is not the invoice — it is operations.** At current team size, an hour spent patching a self-hosted stack costs more than a year of the free tier. That is the single strongest argument for renting storage (P1) and against self-hosting until volume forces it.

**Cost trajectory:**

| Stage | Cost | Trigger to move on |
|---|---|---|
| Today — both products, 2–10 GB/mo | **$0** | — |
| 4th user, or >10k series / >50 GB/mo | ~$19–50/mo | measured, not guessed |
| >100 GB/mo sustained | self-host OpenObserve (S3/Parquet) | economics flip decisively |

**Re-evaluation triggers** (decide on data, not vibes):

- \>10k active series, >50 GB/month, or a 4th user needed → price Pro vs SigNoz Cloud
- \>100 GB/month sustained → model OpenObserve self-host; S3/Parquet economics win decisively
- interactive retention >14 days becomes a real need → compare Pro retention vs querying the archive tier

---

## 7. Implementation phases

Each phase is independently shippable and leaves the system better than before. Phases 0–4 cover the backend; Phase 5 covers the browser.

### Phase 0 — Package and fix (1–2 days)

1. Publish `@quynhonsemiconductor/observability` with the exports in §3.1.
2. Migrate rova api + worker onto it — deletes both `otel.ts` copies and both logger blocks (defects 1, 5).
3. Fix defects 2 (dead `userId`), 3 (`withJobContext` in cron/relays/consumers), 8 (comment/code mismatch, and skip `/v1/readyz` too).

**Acceptance:** one logger factory and one otel bootstrap in the codebase; worker logs carry `correlationId` and redact credentials; `pnpm test` + e2e green.

### Phase 1 — Turn tracing on in develop (1–2 days)

1. New `observability-agent` TF module (collector sidecar + config + token from Secrets Manager).
2. Wire it into rova develop; set `OTEL_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
3. `SERVICE_VERSION` from the image tag via `qnsc-ci` (defect 7).
4. Create both Grafana stacks and the per-product tokens; add the CloudWatch datasource; configure Loki/CloudWatch → Tempo derived field on `trace.id`.

**Acceptance:** a request to rova develop produces a trace in Tempo whose spans include pg and redis children; clicking a log line jumps to its trace; every signal carries the §3.3 attributes.

### Phase 2 — Metrics that exist (2 days)

1. Implement §3.4 in the shared package; delete every unused `OTEL_METRICS` name.
2. Emit HTTP RED from the interceptor, job/queue metrics from the wrappers, pool gauges from the DB module.
3. Add the cardinality guard test.
4. First dashboards: service RED, DB/cache USE, queue lag.

**Acceptance:** dashboards show real data for rova develop; no metric carries an id-shaped label; `security.fail_open` is visible.

### Phase 3 — Async continuity, sampling, alerts (2 days)

1. `traceparent` through outbox rows and SNS/SQS attributes (defect 4) → end-to-end API→worker traces.
2. Collector **gateway** ECS service + tail sampling per §3.5 (fixes defect 6).
3. Alert rules: `security.fail_open` > 0, HTTP 5xx rate, p95 latency, queue lag, job failures, DB pool saturation. Route per product.

**Acceptance:** one trace spans an API request and the worker that finished the job; a forced error is present in traces despite prod sampling; an alert fires end-to-end into the product channel.

### Phase 4 — Prod, SLOs, and the port (2–3 days)

1. Enable in rova prod. Watch quota for a week.
2. Define SLOs (availability, p95 latency per critical route) and burn-rate alerts.
3. Port to opshub: package dependency + module version + service name. **This is the test of §4** — if it takes more than a day, the abstraction is wrong.
4. Optional: `awsfirelens` in the shared module if Loki-native logs are wanted.

**Acceptance:** prod dashboards and alerts live; opshub onboarded via configuration only; a documented runbook per alert.

### Phase 5 — Frontend and outside-in (2 days, optional but the biggest remaining blind spot)

1. Grafana Faro in `apps/web`: JS errors, web vitals, and `traceparent` propagation so a browser action links to its API trace.
2. Synthetic uptime checks per public endpoint per environment.
3. Optional: Cloudflare Workers Logpush for the Pages Function.

**Acceptance:** a deliberate JS error appears with its stack and the user's route; a synthetic failure pages before a user reports it.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Cardinality explosion blows the free tier | §3.3 rules + guard test + sidecar volume caps; alert on ingest volume itself |
| Noisy neighbour — one product starves another's quota | Per-product volume caps in each product's own sidecar |
| Vendor outage leaves us blind | CloudWatch remains the always-on fallback with 90-day retention |
| Telemetry causing an outage | `memory_limiter`, async export, drop-on-backpressure. The SDK never blocks a request |
| Free-tier limits change | P1 keeps switching cheap: one exporter block. Triggers in §6 force a periodic look |
| Sidecar adds Fargate cost | ~128 MB/0.1 vCPU; measure at Phase 1 and fold into the task-size decision |
| Another dead layer (this document's own failure mode) | Every phase has an acceptance criterion that requires **observed data**, not merged code |

---

## 9. Decisions

Items 1–4 are **assumed as stated** unless objected to before Phase 0 starts — recorded so the choice is visible rather than implicit. Items 5–7 are genuinely open.

| # | Decision | Assumed | Rationale |
|---|---|---|---|
| 1 | Backend | **Grafana Cloud free tier** | $0, OTLP-native, team already knows LGTM. SigNoz Cloud is the alternative if logs grow faster than metrics |
| 2 | Home for stacks + dashboards-as-code | **`qnsc-infra`** | Already owns cross-product bootstrap; avoids a fourth repo |
| 3 | 3-user free-tier limit | **Accepted for now** | Most likely first upgrade trigger; $19/mo when it fires |
| 4 | Pending R9 change (fail-open field + CloudWatch alarm) | **Commit now** as the interim control | Works with OTel off; Phase 3 replaces the alarm and keeps the log field |
| 5 | **Grafana Cloud region** | *open* | Pick the closest to `ap-southeast-1` and record it. Affects latency and the "where does our data go" answer |
| 6 | **Alert destination** | *open* | SNS email works today for the R9 alarm. Grafana alerting → Slack/Teams from Phase 3; needs a channel and an owner |
| 7 | **Who responds** | *open* | An alert with no owner is a dashboard. Needs a named responder per severity and a runbook location (proposed: `docs/runbooks/<alert>.md`) |

---

## Appendix A — Alert catalogue

| Alert | Condition | Severity | Runbook |
|---|---|---|---|
| Security control failed open | `security.fail_open` > 0 for 5 min | page | Check ElastiCache health; revoked tokens are being accepted |
| Elevated 5xx | HTTP error ratio > 2% for 10 min | page | Check recent deploy, DB, dependencies |
| Latency regression | p95 > SLO for 15 min | ticket | Compare to previous release via `service.version` |
| Queue lag | `queue.lag_seconds` > 300 | ticket | Worker health, outbox relay logs |
| Job failure | `job.failures` > 0 | ticket | Named cron runbook |
| DB pool saturation | `db.pool.waiting` > 0 for 5 min | ticket | Slow queries, pool size, RDS metrics |
| Ingest volume anomaly | telemetry GB/day > 2× baseline | ticket | Cardinality or log-level regression |

## Appendix B — Environment variables

| Variable | Default | Set where |
|---|---|---|
| `OTEL_ENABLED` | `false` | infra per env — `true` from Phase 1 (develop) / Phase 4 (prod) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | infra — the sidecar |
| `OTEL_SERVICE_NAME` / `OTEL_WORKER_SERVICE_NAME` | `rally-api` / `rally-worker` | infra |
| `SERVICE_VERSION` | `dev` | **CI**, from the release tag |
| `OTEL_SAMPLING_PROBABILITY` | `1.0` dev / `0.1` prod | infra — becomes advisory once tail sampling lands |
| `LOG_LEVEL` | `info` | infra — `debug` never in prod |
| `OBSERVABILITY_TOKEN` | — | Secrets Manager, per product per env |

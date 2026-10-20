# Plan — rally dev + prod under $100/mo

> **ARCHIVED 2026-10-18: historical plan, do not follow.** Two parts no longer match the code:
> - The Cloudflare Tunnel token is no longer a key in the app bundle (`rally/<env>/app`, `tunnel-token`). It is
>   a standalone, Terraform-managed secret named `<product>/<env>/tunnel-token-tf` (`infra/modules/stack/main.tf`).
> - "rally" is the old product name in this plan. The product is now rova.
>
> Kept as history, so it is not deleted. Cost figures are as of 2026-08-02.

Target: **both environments, prod live, under $100/mo.** Decided 2026-08-02.

The current architecture cannot reach it. Prod alone at go-live is ~$142/mo before dev
exists, because the design is managed-RDS + Fargate + ALB + managed-cache, twice over.
Reaching the target needs the design to change, not the settings.

**End state: ~$81/mo with production live.** Against ~$223/mo on the current
architecture at launch, and ~$112/mo today with prod still idle.

---

## Where the money goes today

| | $/mo | |
|---|---|---|
| 2× ALB | 36.80 | dev + prod |
| 5× public IPv4 | 18.25 | one per ALB per enabled AZ |
| dev cache | 12.41 | ElastiCache has no stopped state |
| dev RDS | 12.04 | ~12h/day after the idle-schedule fix |
| 2× fck-nat | 8.32 | already the cheap option ($3 vs $33 NAT gateway) |
| RDS storage 50 GB | 6.90 | billed even while an instance is stopped |
| dev Fargate | 6.00 | Spot, ~12h/day |
| Config, ECR, S3, CloudWatch | 7.00 | |
| KMS, alarms, secrets | 4.00 | |
| **total** | **111.72** | |

Going live adds **+111.26** (prod RDS, prod Fargate, prod cache, 9 more alarms) for
**~$223/mo**.

## Target state

| | $/mo |
|---|---|
| prod RDS t4g.micro + 30 GB | 28.23 |
| prod api Fargate 512/1024 on-demand | 20.72 |
| prod cache t4g.micro | 12.41 |
| prod worker Fargate Spot | 6.22 |
| prod fck-nat | 4.16 |
| KMS, secrets, Config, ECR, misc | 9.00 |
| **total** | **~81** |

No ALBs. No persistent dev environment. Prod sized to measured load rather than to a
guess.

---

## The four changes

### 1. Cloudflare Tunnel replaces both ALBs — −$55.05

Every request already reaches the API through Cloudflare: the SPA is a Cloudflare Pages
project whose Function proxies `/v1/*` to `API_ORIGIN`, and the ALB security group only
admits Cloudflare edge ranges. The ALB is therefore an extra hop that terminates TLS a
second time and bills $18.40/mo plus $3.65 per enabled AZ.

`cloudflared` runs as a sidecar in the api task and dials out to Cloudflare, so there is
no inbound listener, no public IPv4, and no ALB.

**Verified compatible with SSE**, which is the risk worth checking before committing:
`NotificationSseController` writes a `: heartbeat` comment every **25 seconds**
(`notification-sse.controller.ts:135`), comfortably inside Cloudflare's ~100s idle
timeout. The heartbeat exists precisely to hold connections open through proxies.

**What is given up:** ALB access logs (the S3 bucket and its lifecycle policy become
unused), the option of an origin-side AWS WAF, and per-target-group CloudWatch alarms —
`rally-prod-api-alb-latency-high` and the target-health alarm have no equivalent and
must be replaced by Cloudflare analytics or dropped.

**Also removes** the shared-ALB host-routing design that `runtime-prod` is built around.
opshub's prod stack is written against that ALB and would need the same treatment before
it launches. This is the change with the largest blast radius outside rally.

### 2. Delete the persistent develop environment — −$63.08

Removes dev's ALB, IPv4, RDS, cache, Fargate and NAT. Local development already works:
`docker-compose.dev.yml` runs `postgres:18.6`, `valkey/valkey:8.1.10-alpine` and
localstack, and `pnpm db:migrate` seeds.

**What is given up:** the shared `rally-dev.qnsc.vn` URL, the deploy-to-dev CI path, and
somewhere to reproduce a bug against realistic data. Every merge to `main` currently
deploys develop and runs migrations against it — that signal disappears, so schema and
deploy problems surface first in production unless PR-preview environments replace it.

This is the single largest saving and the largest workflow change. It is also what makes
the develop-first pattern used repeatedly in this repo — for `db_least_privilege`, for
the secrets bundle — no longer possible.

### 3. Prod RDS `t4g.micro`, not `t4g.small` — −$24.09

$24.09/mo against $48.18. 1 GB rather than 2 GB.

Resizing later is one flag and a short downtime, so this is reversible on evidence.
Multi-AZ was already declined separately (2026-08-02) and stays declined; keep
`backup_retention_days = 30`, because PITR is what makes a single-AZ failure a
recoverable outage rather than data loss.

### 4. Prod api Fargate 512/1024, not 1024/2048 — −$20.73

**This one is measured, not estimated.** Develop's api runs 512/1024 and reports
**0.4% average CPU, 12% average memory, 21% peak memory** over the week to 2026-08-01.
Production was planned at 1024/2048 — four times develop — for an environment that has
never served a user.

512/1024 leaves roughly 8× memory headroom at launch traffic, and autoscaling
(`max_count = 10`) covers growth. Without this change the target lands at $101.47 and
misses; with it, $81.

---

## Sequence

The ordering is load-bearing. **Deleting develop removes the only place the Tunnel can
be proven**, so it goes last.

### Phase 1 — Tunnel on develop, ALB still live

1. Create a Cloudflare Tunnel; store its token in Secrets Manager (`rally/develop/app`
   gains a `tunnel-token` key — the bundle already exists).
2. Add a `cloudflared` sidecar to the develop api task definition.
3. Point a second hostname (`rally-api-dev-tunnel.qnsc.vn`) at the Tunnel, leaving
   `rally-api-dev.qnsc.vn` on the ALB.
4. **Verify against the tunnel hostname:** `/v1/readyz`, an Entra SSO login end to end,
   an SSE stream held open past 2 minutes to prove heartbeats survive, and a file
   upload/download through R2.
5. Cut `rally-api-dev.qnsc.vn` to the Tunnel. Rollback is a DNS change.

Exit criterion: develop serves entirely through the Tunnel for at least one full working
day, including a deploy.

### Phase 2 — Tunnel on production, delete both ALBs

1. Same sidecar in the prod api task; `rally/production/app` gains `tunnel-token`.
2. Cut `rally-api.qnsc.vn` to the Tunnel.
3. Delete both ALBs (`enable_alb = false` in `runtime-dev` and `runtime-prod`), which
   releases all 5 public IPv4.
4. Remove `attach_alb` from the product stacks, and drop the two ALB-derived alarms.

Prerequisite: rally's stack hardcodes `attach_alb = true` (`stack/main.tf:515`); it must
become a variable first. That module is shared with opshub.

### Phase 3 — Resize production

`instance_class = "db.t4g.micro"` and api `cpu = 512, memory = 1024`. Configuration
only; no new mechanism.

### Phase 4 — Delete the develop environment

Last. Remove `infra/live/develop`, `runtime-dev`, and the deploy-to-develop CI path.
Keep `docker-compose.dev.yml` as the development story.

---

## Risks, stated plainly

**Production launches onto an unproven ingress path.** The decision was to refactor
before launch rather than after, which saves roughly $150 of transitional cost and means
prod's first real traffic runs on infrastructure that has never carried real traffic.
Phase 1 is what mitigates this: prove it on develop first, and do not start Phase 2
until develop has run a full day on the Tunnel.

**Deleting develop removes the safety net for everything after it.** After Phase 4 there
is no environment to validate a change before production. This is why Phase 4 is last
and why Phase 1 must not be skipped.

**opshub is affected.** The shared ALB in `runtime-prod` is part of a design opshub's
prod stack already targets. Phase 2 changes that contract; opshub needs the same Tunnel
treatment before it launches, or it needs the ALB back.

**Losing ALB alarms loses outage detection.** `monitor_target_health` is described in
`prod/main.tf` as "the only alarm that catches an outage producing no load to move CPU,
latency or 5xx." With no ALB there is no target group and no such alarm. Cloudflare
health checks or a synthetic probe should replace it before launch, or production has no
outage detection for that failure mode.

**t4g.micro is 1 GB.** If launch traffic is heavier than expected, the symptom is
connection exhaustion or OOM, not gradual slowness. `max_allocated_storage_gb` autoscales
storage but nothing autoscales the instance class.

## Effort

| phase | work |
|---|---|
| 1 | ~1 day — sidecar, tunnel token, DNS, verification |
| 2 | ~half day — plus `attach_alb` plumbing in the shared module |
| 3 | ~1 hour — two values |
| 4 | ~half day — removal plus CI cleanup |

## What is NOT in this plan, and why

- **Changing cloud provider.** Three AWS SDK clients in the app (S3, SES, Secrets
  Manager — SNS and SQS are gone, see `docs/DIVERGENCE.md`), plus ECR. Rewriting that
  layer costs weeks; Hetzner with managed Postgres lands ~$30–40/mo, barely better than $81 for
  vastly more work. A single Hetzner VM running everything would be under €10/mo, but
  that is a different operational model with no managed backups and self-owned uptime.
- **Prod api on Fargate Spot.** Saves $29/mo and drops in-flight requests plus SSE
  streams on a 2-minute interruption notice. Declined: the worker is already Spot for
  sound reasons, and the api is not, for equally sound ones.
- **Containerising dev's datastore.** Superseded — Phase 4 deletes dev entirely, which
  saves more.
- **Dropping the prod cache.** `REDIS_URL` is required with no fallback, the cache module
  runs in `mode: 'required'`, and a `check` block forbids running tasks without it.
  Sessions live only in Valkey.

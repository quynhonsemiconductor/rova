# Runbook — taking rova production live

Production is deliberately idle: **zero tasks, RDS stopped, no cache node, no NAT, no
ALB.** That posture costs ~$4/mo instead of ~$110, and every part of it is a flag.

This runbook exists because those flags are spread across **two repositories** and the
order matters. Several steps fail at *task start* rather than at *apply*, so Terraform
reports success and the environment simply never comes up.

Read the whole thing before starting. Budget 60–90 minutes.

---

## Before you begin

**Decide which release ships.** Production has never been deployed. `v0.6.1` is tagged
and promoted to ECR, but its deploy was cancelled on 2026-08-01 while production was
idle — so the newest tag is *not* live, and nothing is. Pick deliberately; do not assume.

**Know the two things that have never been tested:**

1. **Production's Cloudflare Tunnel has never carried a request.** It reports `inactive`
   with 0 connections because no task has ever run. The configuration is identical to
   develop's, which works — but production's first request will be a real one.
2. **The ALB rollback is gone.** Both load balancers were deleted. Falling back to ALB
   ingress now takes 25–30 minutes and produces a **new ALB DNS name** that must
   propagate.

**Have ready:** AWS SSO session (`qnsc-admin`), a Cloudflare API token with Tunnel +
DNS write, and access to both `quynhonsemiconductor/rova` and `quynhonsemiconductor/infra`.

---

## Step 1 — Restore egress (qnsc-infra)

**Do this first. Nothing else works without it.**

`platform/qnsc-infra/live/runtime-prod/main.tf`:

```hcl
nat_type = "instance"   # currently "none"
```

Apply. This recreates the fck-nat instance (~$4.16/mo).

**Why first:** Fargate cannot pull from ECR, read Secrets Manager or reach R2 without
egress — and `cloudflared` cannot dial out to Cloudflare either, so a tunnelled task has
no *ingress* either. The failure is `ResourceInitializationError` at task start, long
after Terraform reports success.

**Verify:**
```bash
aws ec2 describe-instances --region ap-southeast-1 \
  --query 'Reservations[].Instances[?State.Name==`running`].[Tags[?Key==`Name`].Value|[0]]' \
  --output text
# expect: qnsc-runtime-prod-nat-instance
```

---

## Step 2 — Restore the cache and the service floors (rova)

These **must move together**. A `check` block in `infra/modules/stack/main.tf` enforces
it: `cache.enabled = false` requires `min_count = 0` on both services, because a task
that cannot reach its cache does not fail — it falls back to localhost and runs with the
token denylist and rate limiter **failed open**.

`rova infra live/prod/main.tf`:

```hcl
cache = {
  enabled = true          # currently false
}

api = {
  min_count          = 1  # currently 0
  enable_autoscaling = true   # currently false
  # cpu/memory: see the sizing note below before changing
}

worker = {
  min_count          = 1  # currently 0
  enable_autoscaling = true   # currently false
}
```

A `validation` block rejects `enable_autoscaling = true` with `min_count = 0`, so these
two cannot drift apart.

**Cache creation takes ~10 minutes and issues a NEW endpoint.** Harmless now (no
sessions to lose), but the task definition must be registered *after* the cache exists —
Terraform handles the ordering, the deploy in step 5 picks it up.

Apply.

---

## Step 3 — Remove the weekly stop, and start the database

`rova infra live/prod/main.tf` — **delete** this line entirely:

```hcl
idle_schedule = "cron(0 1 ? * SUN *)"
```

It exists because AWS force-starts a stopped RDS instance after 7 days; it re-stops it
every Sunday at 01:00. **Left in place, it will stop production every Sunday morning** —
exactly the kind of leftover that becomes an outage nobody can explain.

Apply, then start the database out of band (RDS run-state is not a Terraform concept):

```bash
aws rds start-db-instance --db-instance-identifier rova-prod --region ap-southeast-1
aws rds wait db-instance-available --db-instance-identifier rova-prod --region ap-southeast-1
```

Takes 5–10 minutes.

**Optional, decide separately:** production RDS is `db.t4g.micro` (1 GB) with
`monitoring_interval = 0`. `docs/go-live-cost-delta.md` prices `db.t4g.small` at +$24/mo
and Enhanced Monitoring at +$2.10/mo. Multi-AZ was **declined** on 2026-08-02 — see that
document for the availability tradeoff and the conditions to revisit. Keep
`backup_retention_days = 30`: with single-AZ, PITR is what makes an AZ failure a
recoverable outage rather than data loss.

---

## Step 4 — Deploy

Push the release tag, or re-run the deploy for the tag you chose. The production deploy
is gated by the `production` GitHub Environment's required reviewer.

The pipeline promotes the exact develop image to the release tag, migrates, then rolls
the services.

**Watch for:** `deploy / Deploy (production)` waiting on approval. Approve it.

---

## Step 5 — Verify ingress BEFORE announcing anything

**This is the step that cannot be skipped.** Production's tunnel is unproven, and every
failure mode here is silent — the ALB alarm that used to catch "running but not serving"
no longer exists.

```bash
# 1. Does the connector hold live edge connections?
curl -s "https://api.cloudflare.com/client/v4/accounts/69e52835cf2d08edde5b6ebd741d30fa/cfd_tunnel/27d68d57-6acf-4516-98e1-dab55ea0512e" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; print(r['status'], len(r['connections'] or []))"
# expect: healthy 4     (NOT "inactive 0")

# 2. Does the public hostname answer?
curl -s -o /dev/null -w "%{http_code}\n" https://rova-api.qnsc.vn/v1/healthz     # expect 200
curl -s https://rova-api.qnsc.vn/v1/readyz                                       # expect postgres+valkey up

# 3. Does the real user path work?
curl -s -o /dev/null -w "%{http_code}\n" https://rova.qnsc.vn/                    # SPA
curl -s -o /dev/null -w "%{http_code}\n" https://rova.qnsc.vn/v1/healthz          # BFF proxy
```

Then **log in through Entra SSO in a browser** and hold a page open for two minutes to
confirm the SSE notification stream survives — the heartbeat is 25s against Cloudflare's
~100s idle timeout, verified on develop but never on production.

Only after all of this: announce.

---

## Step 6 — Restore outage alerting

`rova infra live/prod/main.tf`:

```hcl
monitor_target_health = true    # currently false
```

**Read this before flipping it.** This alarm reads an ALB target group. Production has
**no ALB** — ingress is the tunnel — so with `tunnel_enabled = true` the stack passes an
empty `target_group_arns` and *this alarm is not created at all*.

What covers ingress instead is `aws_route53_health_check.api_ingress` — but it **does not
exist right now**. It was deleted on 2026-08-04 (`monitor_ingress = false`): with zero
tasks it reported DOWN continuously, billing $2.70/mo to page every minute about the
state production is deliberately in.

**So production currently has NO ingress alarm of any kind.** Restore it here:

```hcl
monitor_ingress = true    # currently false
```

Apply. That recreates the health check, the us-east-1 alarm and its SNS topic, which
probes `rova-api.qnsc.vn/v1/healthz` from outside AWS and pages `nghiavt@qnsc.vn`
(Route 53 publishes `HealthCheckStatus` only in us-east-1).

Set it in the **same change** as `min_count` and before announcing. While tunnelled this
is production's only ingress alarm — ECS reports a task RUNNING whether or not
`cloudflared` holds edge connections, so without it an outage is visible only when a user
reports it.

**It starts in ALARM and takes ~3 minutes to go OK** (3 × 60s datapoints). Confirm:

```bash
aws cloudwatch describe-alarms --region us-east-1 \
  --alarm-names rova-prod-api-ingress-down \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text
# expect: OK
```

So `monitor_target_health` only matters if you ever roll back to ALB ingress. Leave it
false while tunnelled.

---

## Rollback — tunnel ingress fails at step 5

Recovery is **25–30 minutes** and produces a **new ALB DNS name**. Order matters.

1. `platform/qnsc-infra/live/runtime-prod/main.tf`: `enable_alb = true`, and restore
   `enable_deletion_protection = true` in the `module "alb"` block. Apply. (~4 min.)
2. `rova infra live/prod/main.tf`: `tunnel_enabled = false`. Apply.
3. Redeploy so the services roll onto a task definition with the ALB target group and no
   `cloudflared` sidecar.
4. `dns_api` switches the CNAME back to the ALB automatically — allow for propagation.

**Why this order:** a product stack attaching a host-header listener rule fails if the
listener does not exist yet.

**Known trap:** with the ALB module gated by `count`, Terraform plans the *destroy* of a
resource no longer in configuration and never applies an
`enable_deletion_protection = false` written beside it — the API refuses with
`OperationNotPermitted`. Clearing protection has to happen out of band *before* a later
teardown.

---

## After go-live — the flags that are now wrong

Once production is serving, these no longer describe reality and will mislead the next
reader:

| file | flag | why |
|---|---|---|
| `qnsc-infra/live/runtime-prod` | `enable_alb = false` | correct while tunnelled — leave, but the comment says "pre-launch" |
| `rova infra live/prod` | `secrets_recovery_window_days = 30` | fine, keep |
| `qnsc-infra/live/security-baseline` | `enable_config = false` | **turn on before any SOC 2 engagement** — history cannot be backfilled |

## Cost after go-live

**Today's measured baseline is ~$1.80/day → ~$55/mo**, from two clean billing days
(2026-08-02 and 08-03) after the cuts landed. Earlier drafts said ~$35; that was an
estimate, and it was low — prod's 30 GB of RDS storage bills while the instance is
stopped, and dev's RDS runs ~14h/day rather than the 12 assumed.

Read a partial-month bill carefully: it is cumulative month-to-date, so lines for the
ALB, AWS Config and the public IPv4 addresses deleted on 08-01 stay printed all month
and look like ongoing charges. They are not. Check daily granularity in Cost Explorer,
and expect the newest day to read $0.00 — AWS lags roughly 24h.

Going live adds NAT, the cache, RDS compute, two Fargate tasks and this ingress check —
see `docs/go-live-cost-delta.md` for the line-by-line.

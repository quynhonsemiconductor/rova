# Go-live cost delta — what launch does to the AWS bill

**Bottom line: go-live adds $58.87/mo to production, taking rova prod from ~$6/mo idle
to ~$64/mo running.** None of it is waste — it is the price of a database that is
awake, two tasks that answer requests, a cache that makes two security controls fail
closed, and one alarm that notices when none of that is true.

This exists because the go-live checklist in `infra/live/prod/main.tf` had never been
costed. Every item in it was defensible; the total was never added up, and three of the
items turned out not to survive being costed.

## Rates are MEASURED, not quoted

Every figure below comes from **Cost Explorer unblended cost ÷ usage quantity on the
July 2026 bill**, in this account, in ap-southeast-1. Monthly figures assume 730 hours.

That matters, because the first version of this document used list prices typed from
memory and **every one of them was wrong** — RDS t4g.micro by +32%, the cache node by
−20%. A costing document sourced from recollection is worse than none: it reads as
evidence. If a rate below needs updating, re-derive it the same way:

```bash
aws ce get-cost-and-usage --time-period Start=2026-07-01,End=2026-08-01 \
  --granularity MONTHLY --metrics UnblendedCost UsageQuantity \
  --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon ElastiCache"]}}'
```

| resource | measured rate | $/mo at 730 h |
|---|---|---|
| Fargate on-demand | $0.050560/vCPU-h + $0.005530/GB-h | — |
| Fargate Spot | $0.015634/vCPU-h + $0.001710/GB-h | — |
| RDS db.t4g.micro, single-AZ, PostgreSQL | $0.0250/h | 18.25 |
| RDS gp3 storage | $0.138/GB-mo | 4.14 at 30 GB |
| ElastiCache cache.t4g.micro | $0.021165/h | 15.45 |
| CloudWatch alarm | $0.10/alarm-mo | — |

## The two postures

Production was **pre-launch idle** from 2026-08-02 until go-live: zero tasks, RDS
stopped, no cache node, several alarms off. Not a degraded state — a deliberate posture
with a defined end date.

| | idle | at go-live | delta |
|---|---|---|---|
| RDS instance | t4g.micro, **stopped** (bills $0) | t4g.micro **running**, single-AZ | **+$18.25** |
| RDS storage | 30 GB gp3 | 30 GB gp3 (unchanged) | $0 |
| RDS Enhanced Monitoring | off | **still off** — declined below | $0 |
| Fargate api | 0 tasks | 1× **256**/1024 on-demand, **ARM64** | **+$10.61** |
| Fargate worker | 0 tasks | 1× **256/512** Spot, **ARM64** | **+$2.78** |
| ElastiCache | none | cache.t4g.micro | **+$15.45** |
| Route 53 ingress health check | off | 30s HTTPS check | **+$2.70** |
| NAT egress (`runtime-prod`) | `nat_type = "none"` | fck-nat t4g.nano | **+$3.86** |
| Public IPv4 for the NAT | none | 1 address | **+$3.65** |
| CloudWatch alarms | 12 | 21 (autoscaling ×8, ingress ×1) | **+$0.90** |
| **total** | | | **+$58.87/mo** |

Rova production then runs at roughly **$64/mo** all-in (the delta plus the $4.14 storage
and ~$1.20 of secrets it already bills), excluding the rest of the shared platform layer
and data transfer.

The NAT line is the one item that is **not** in this repository. It lives in
`qnsc-infra/live/runtime-prod`, and it is not optional: with `nat_type = "none"` a Fargate
task cannot pull from ECR, read a secret, or let cloudflared dial out — so production has
no ingress either. It fails at task start with `ResourceInitializationError`, long after
a clean apply. See quynhonsemiconductor/infra#68, which must land **before** the floors go to 1.

### Three checklist items were declined on cost

They were in the checklist, they were costed, and they did not survive it. Each is one
line and an apply to reverse, and each has a **named signal** that revokes the decision —
written next to the setting in `infra/live/prod/main.tf`, not only here.

| declined | would cost | revoke when |
|---|---|---|
| `instance_class = "db.t4g.small"` | **+$18.98/mo** ($37.23 vs $18.25) | `CPUCreditBalance` trending to zero, or `FreeableMemory` under ~100 MB |
| `monitoring_interval = 60` | ~+$2.10/mo | investigating a specific incident — then turn it back off |
| `multi_az = true` | **+$22.39/mo** on micro ($18.25 doubled instance + $4.14 mirrored volume) | see the section below; this is the one that trades availability |

Together they are **$43.47/mo**, which is why this document says ~$67 rather than ~$111.
Both burstable-instance signals are free native CloudWatch metrics, so watching for the
moment the first decision expires costs nothing.

The earlier version of this document recommended flipping all three. It reached that
conclusion honestly and with bad arithmetic: it priced t4g.small at $48.18/mo against a
**stopped** micro, making the upgrade look like a rounding error inside a $112 delta. At
measured rates the small is a 104% increase on the instance line for RAM nothing has
asked for.

## Line by line

### RDS: +$18.25 — the instance simply wakes up

The class does **not** change. The instance was stopped, billing storage only, so the
delta is the whole running rate rather than the difference between two sizes:

| | measured rate | $/mo |
|---|---|---|
| **t4g.micro single-AZ (idle and live)** | **$0.0250/hr** | **18.25** |
| t4g.small single-AZ (declined) | $0.0510/hr | 37.23 |
| t4g.micro Multi-AZ (declined) | $0.0500/hr | 36.50 |
| t4g.small Multi-AZ (declined) | $0.1020/hr | 74.46 |

t4g is **burstable**, which is what makes holding at micro a measured risk rather than a
gamble: the instance earns 12 CPU credits/hour at a 10% baseline and spends them on
spikes. Exhausting them throttles gradually; it does not fall over. `CPUCreditBalance`
trending to zero is the signal, and the fix is one line and a ~2-minute reboot — no
snapshot, no endpoint change.

Enhanced Monitoring stays at `0`. It streams OS-level metrics to CloudWatch Logs to
answer "which process", a question a single-application database rarely raises;
Performance Insights' free 7-day tier and the native CPU/memory/IOPS metrics cover what
actually gets asked. It takes effect without a reboot, so it is a debugging tool to
switch on during an incident, not a posture to carry.

#### Multi-AZ was considered and declined (2026-08-02, re-costed 2026-08-17)

On the micro it is **+$22.39/mo** ($18.25 doubled instance rate + $4.14 mirrored volume)
— the largest single item declined here, and the only one that trades **availability**
rather than deferring spend.

The original decision was taken against a $52.32/mo figure derived from t4g.small. The
number was wrong; the decision was not, and it stands at the corrected price for the same
reasons below.

This is the one decision here that trades **availability**, not deferred spend:

| | AZ failure |
|---|---|
| Multi-AZ | automatic failover, ~60–120s, no data loss |
| **single-AZ** | **database down** until AWS restores the AZ, or a manual snapshot restore into another AZ — hours |

The exposure is an outage measured in hours, **not** permanent data loss — provided
`backup_retention_days = 30` stays, because PITR narrows the loss window to ~5 minutes.
Those two settings are now coupled: **do not lower retention while single-AZ.**

Revisit when the product carries paying users, an availability commitment (SLA,
contract, SOC 2 CC7.x continuity), or a workload where hours of downtime costs more than
$22/mo. **Not a one-way door** — RDS converts single-AZ to Multi-AZ in place: one flag,
one apply, a brief failover, no data migration and no endpoint change.

`prod/main.tf` already argues the general case correctly: every dollar currently buys
durability for a database with no users. That reverses the moment there are users.

### Fargate: +$13.39 — sized from measurement, and on Graviton

Both services sat at `min_count = 0`. Production had **never served a real user** — the
ALB logged 4, 1, 0, 1 requests on four consecutive days, and the non-zero days since were
SCM webhooks and synthetic probes.

At go-live both floors return to 1:

- **api**, 256/1024 on-demand: (0.25 × $0.050560 + 1 × $0.005530) × 730 = **$13.26/mo**
- **worker**, 256/512 Spot: (0.25 × $0.015634 + 0.5 × $0.001710) × 730 = **$3.48/mo**

The api went 1024/2048 → 512/1024 → 256/1024. Only the last step was taken with **data**.

Measured on `rally-develop` from AWS/ECS, 14 days to 2026-08-17 — same image, same
workload production will run:

| service | size | CPU avg / peak | memory avg / **peak** |
|---|---|---|---|
| api | 512/1024 | 0.8% / 100% | 14.2% / **25.9% = 265 MB** |
| worker | 256/512 | 1.5% / 100% | 20.7% / **35.8% = 183 MB** |

The api never exceeded **265 MB of 1024**. The CPU peaks are one-minute boot and
migration bursts against a 0.8% average — not load. Provisioning 0.5 vCPU to make those
bursts finish faster was $9.23/mo for a shorter cold start.

**Memory was deliberately not halved.** 256/512 is available and $2.02/mo cheaper, and it
is declined: 265 MB against 512 MB is 52% *before* production adds what develop lacks —
real sessions, held-open SSE streams, a warmer pool. Two dollars is the wrong price for
that margin. CPU is where the waste was.

The worker simply adopts the size develop has run all along, so production is taking a
proven number rather than guessing a smaller one.

**What this costs is a slower cold start** — a deploy-duration cost rather than an
availability one, since the rolling deployment starts the replacement before draining the
old task. It does lengthen the gap when a single task is replaced unexpectedly. Watch it.

**Both run on Graviton (ARM64)**, which is ~20% less per vCPU-hour and GB-hour at
identical sizing: the api is $10.61 rather than $13.26 and the worker $2.78 rather than
$3.48. Proven in develop first (#447), and set before launch rather than after — production
has never served a request, so it starts on ARM instead of being migrated to it.

`max_count = 10` at a 60% CPU target is where headroom actually lives: production absorbs
a spike by **adding** tasks, now from a $13.26/mo unit. Four 256-CPU tasks cost less than
one 1024 and survive an AZ event.

Spot on the worker is worth **$7.77/mo** at this size ($11.25 on-demand vs $3.48) and is
justified in the code: the relay claims rows `FOR UPDATE SKIP LOCKED` and every write is an idempotent
upsert, so an interruption loses no work. The api stays on-demand because an interruption
there is a dropped request and a broken SSE stream.

A floor of 1 is **not** a high-availability posture and nothing claims it is: one api
task means a task replacement or an AZ event is a brief outage. Raising the floor to 2 is
$13.26/mo and is a traffic decision, not a launch-day one.

### ElastiCache: +$15.45

`cache.enabled = false` while idle. ElastiCache has no stopped state — only delete — so
the node is the one component of an idled environment that keeps billing, which is why it
was removed.

cache.t4g.micro: $0.021165/hr = **$15.45/mo**, the second-largest line in the delta. It
is not optional at any price, and the reason is a security property rather than a
performance one:

A `check` block in the stack module enforces that `cache.enabled = false` and
`min_count = 0` move together, because a task that cannot reach its cache does not fail
— it falls back to localhost and runs with the token denylist and rate limiter **failed
open**. So restoring the cache is not optional at go-live; it is coupled to restoring
the floors.

Recreating the node issues a **new endpoint** and takes ~10 minutes. Harmless now
(no sessions to lose); not harmless later.

### Ingress monitoring: +$2.70, and it is not the alarm the checklist named

The checklist said to restore `monitor_target_health`. **That flag is inert here.** It
creates a target-group UnHealthyHostCount alarm, and a tunnelled task has no target
group — the stack module passes `target_group_arns = {}` whenever `tunnel_enabled` is
true, so setting it would have produced a flag that reads as coverage and creates
nothing. It stays `false`, and the file now says why.

What actually comes on is `monitor_ingress`: a Route 53 health check probing
`rally-api.qnsc.vn/v1/healthz` from outside AWS every 30 s, ~**$2.70/mo** ($0.75 base
plus HTTPS and fast-interval options). It exercises the whole user path — Cloudflare
edge, tunnel, connector, app — instead of any one component's opinion of itself.

It is production's **only** ingress alarm while tunnelled. ECS reports a task RUNNING
whether or not cloudflared holds edge connections, and the sidecar image is distroless so
no ECS `healthCheck` can probe it. It was off pre-launch because zero tasks meant it
reported DOWN continuously — paying $2.70/mo to be paged every minute about the intended
state — and that premise ends when the floors go to 1.

### NAT egress: +$4.16 — and it is a hard dependency, not a cost line

`runtime-prod` ran with `nat_type = "none"` while both services sat at zero. Correct then:
no tasks to route, and a fck-nat t4g.nano is pure waste in an environment with none.

It is a **blocker** for go-live, not a nice-to-have. With no default route on the private
route tables, a Fargate task cannot pull its image from ECR, cannot read Secrets Manager,
cannot reach R2, and — the part that surprises — **the cloudflared sidecar cannot dial out
to Cloudflare**. The tunnel is an outbound connection, so `"none"` costs production its
*ingress* as well. The failure appears at task start as `ResourceInitializationError`;
the Terraform apply is clean and the deploy reports a rollout.

fck-nat t4g.nano is the cheap answer at **$4.16/mo**. A NAT gateway is ~$33/mo for the
same job and interface endpoints ~$85/mo across three AZs.

Single-AZ, and `multi_az_nat` is **inert** in instance mode — the module always creates
one instance in `azs[0]`. An AZ failure therefore takes egress from every private subnet,
not just that AZ's. Tasks already running keep serving; nothing new can start. Accepted on
the same reasoning as the database: it is single-AZ too.

Tracked in quynhonsemiconductor/infra#68.

### CloudWatch alarms: +$0.90

Autoscaling returns (4 alarms per service × 2 = 8 at $0.10) plus the ingress alarm.
12 alarms → 21.

## What the table does not include

**Autoscaling headroom.** The figures above price *one* task per service — the floor, not
the steady state. `max_count = 10` for the api, and real traffic at `cpu_target_pct = 60`
will hold more than one task during business hours. A 2-task average on the api adds
**+$13.26/mo**. This is the number most likely to be wrong, in either direction, and only
real traffic settles it.

**Data transfer.** Currently $0 because of the 100 GB/month free allowance, ~15%
consumed pre-launch — and **99% of that was ECR image pulls**, which scale with deploy
frequency, not users. Real user traffic starts consuming it. Past 100 GB/mo the rate is
~$0.12/GB.

`runtime-prod/main.tf` sets the trigger to revisit interface VPC endpoints at ~70 GB/mo
of internet egress, pinned to **one** subnet (~$28/mo, not the ~$85/mo that three
endpoints across three AZs cost in July).

**Backups past the free allowance.** Snapshots ≤ allocated storage are free. At 30 GB
allocated with 30-day retention, growth past that starts billing at ~$0.114/GB-month.

**Log volume.** Prod retains 90 days (SOC 2 CC7.2 minimum). Ingestion scales with
traffic; today it is negligible.

**opshub.** A second product already has `infra/live/prod` written against the shared
runtime layer. When it launches it adds its own RDS, cache, Fargate and secrets — a
second copy of most of this table. The shared ALB, VPC and NAT are already paid for and
do **not** double.

## What does not change at go-live

Worth stating, because it is where the money already is:

| | $/mo | why it is fixed |
|---|---|---|
| 2× ALB + 6 public IPv4 | 62 | shared platform layer; 3-AZ is load-bearing |
| dev environment | ~44 | unchanged by prod launch |
| 1× fck-nat instance (dev) | 4 | already the cheap option ($4 vs $33 NAT gateway); prod's is in the delta above |
| secrets | 0.80 | post-bundling |
| Config, KMS, ECR, S3 | ~12 | already minimised |
| **subtotal** | **~123** | |

**So the account lands near $200/mo with rova live** — ~$123 of shared platform and dev
plus ~$67 of production. Against a $150/mo target, the $50 gap is not in this document:
every configurational item here has already been declined or is load-bearing. It is in
the $62 of ALB and public IPv4 and the ~$44 dev environment, both of which are
architectural questions about running two full environments across three AZs.

The 3-AZ ALB is not padding: a 2-AZ ALB cannot reach targets in the third AZ, which
caused roughly one task placement in three to fail health checks and rolled back
opshub#85. That is documented in `runtime-dev/main.tf`.

## Recommendations

**1. Set the budget expectation at ~$67/mo for rova prod,** on top of whatever dev and
the shared platform layer cost. A production environment with one task per service, a
running database and a cache has a floor, and after declining $43.47/mo of checklist
items this is close to it. The remaining items are load-bearing, not padding.

**2. Do not pre-provision.** Every item above flips **at** go-live, not before. The idle
posture saved $61.55/mo for the fifteen days it was held.

**3. Watch these four after launch,** in order of how wrong the estimate could be:

- api task count under real traffic (the ±$13 line)
- `CPUCreditBalance` and `FreeableMemory` on the micro — the two signals that revoke the
  instance-class decision, both free native metrics
- data transfer out, once past the 100 GB free tier
- RDS storage growth — `max_allocated_storage_gb = 500` autoscales, and **RDS refuses to
  shrink a volume**. Treat any increase as permanent; coming back down needs the
  instance replaced (`docs/runbooks/rds-storage-shrink.md`).

**4. The configuration levers are spent.** Multi-AZ (+$22.39), t4g.small (+$18.98) and
Enhanced Monitoring (+$2.10) are all declined, and the api and worker are sized from
measured utilisation rather than judgement, which is why this says ~$67 rather than
~$111. What remains — the running database ($18.25), the api task ($13.26), the cache
node ($15.45), the Spot worker ($3.48), the NAT and its address ($7.51) — is the
environment itself.

If the number still has to come down, the honest options are architectural rather than
configurational: collapse dev into an ephemeral environment, or delay restoring the api
floor until there is real traffic. Neither is a settings change, and the second means
production is not actually live.

Because Multi-AZ is off, **the recovery path is load-bearing** — so it was rehearsed
rather than assumed.

**Drill run 2026-08-02 against develop.** Restored the latest automated snapshot
(`rds:rally-develop-2026-08-01-03-13`) into a NEW availability zone — source in
`ap-southeast-1b`, restore into `1c`, which is the AZ-failure scenario:

| | result |
|---|---|
| time to `available` | **5 min 4 s** |
| engine / storage / IOPS / DBName / master user | identical to source |
| encryption + KMS CMK | preserved, same key |
| instance class, single-AZ | identical |

The drill instance was deleted immediately after.

**So the "hours" figure above is conservative for the restore itself** — the RDS
operation is minutes. The hours come from what surrounds it: noticing the outage,
deciding to restore, repointing the application at a new endpoint (a restore issues a
NEW hostname, so this is a Terraform change plus a deploy, not a DNS flip), and
verifying data before reopening. Budget for the human path, not the AWS one.

**Two limits of this drill, stated so nobody over-reads it:**

- **Data integrity was not verified.** Both RDS instances sit in private data subnets
  and ECS exec is disabled on develop, so no query could be run against the restored
  database from outside the VPC. What was verified is that AWS reports the instance as
  `available` with matching configuration — not that table contents are correct. A full
  drill needs a one-off ECS task in the VPC running `SELECT count(*)` against a few
  tables and comparing to source.
- **It was develop, not production.** Same engine and class, but 20 GB rather than 30 GB
  and 3-day rather than 30-day retention. Restore time scales with volume size, so
  production will be somewhat slower.

**5. Revisit Fargate Spot for the api only if the budget forces it.** It saves $9.78/mo
and costs dropped requests and broken SSE streams on interruption — and interruptions are
real here, not hypothetical: `SpotInterruption` already appears in develop's stopped-task
reasons. The worker is Spot for sound reasons; the api is not, for equally sound ones.

## The go-live change itself

What actually shipped, in `infra/live/prod/main.tf`:

```hcl
monitor_ingress = true                  # NOT monitor_target_health — inert under tunnel

# idle_schedule removed entirely — a schedule that stops production nightly

cache = { enabled = true }              # ~10 min, issues a NEW endpoint

api    = { cpu = 256, memory = 1024, min_count = 1, enable_autoscaling = true }
worker = { cpu = 256, memory =  512, min_count = 1, enable_autoscaling = true }

rds = {                                 # DELIBERATELY UNCHANGED
  instance_class      = "db.t4g.micro"  # not small — raise on CPUCreditBalance
  multi_az            = false           # declined 2026-08-02
  monitoring_interval = 0               # a debugging tool, not a posture
}
```

A `validation` block on the stack module's `api` and `worker` variables enforces the
`min_count`/`enable_autoscaling` pairing, because autoscaling on with a floor of 0 is a
live environment that cannot self-heal: nothing publishes a metric at zero tasks, so
whatever scaled it down is permanent.

**One item is not in the file.** `v0.6.1` is tagged and promoted to ECR but was never
deployed — both prod approvals were cancelled on 2026-08-01 while prod was idle. The tag
and prod are permanently out of step, so go-live must **deliberately re-run the deploy
for the intended release** rather than assuming the newest tag is live.

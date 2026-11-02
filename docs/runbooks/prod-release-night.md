# rova production: the on-prem move night

Owner-facing. ONE night (owner decision 2026-11-01, fast track): rova prod leaves AWS and **identity 8
ships directly on-prem in the same move**. There is no separate AWS identity night, so anything in the
old checklists that wrote to AWS (Secrets Manager, Pages env, ECS flags, the release tag) does not run.

Order, names and gates only; the credentialed procedures stay in their runbooks:

- data: `sa-notes/onprem/rova-prod-data-move/RUNBOOK.md` (dump, restore, verify, rollback)
- identity: `docs/runbooks/identity-v8-cutover.md`, "Production" — **only the Entra and backfill parts
  still apply** (section 2 below)
- mail: `docs/runbooks/mail-graph.md`, section 9
- gates: `sa-notes/onprem/rova-prod-fast-track-2026-11-01.md` (G1-min, monitoring-min, rehearsal, rollback)

## 0. Prerequisites (all must be true at T-0)

| #   | Gate                                                                                                                         | Owner  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0.1 | `pg-rova` up in `data-prod`; nightly CNPG backup to R2 `qnsc-backups`; **one real restore test passed** (G1-min)             | D      |
| 0.2 | Uptime alert on `https://rova.qnsc.vn/readyz` + CrashLoop alert for rova-prod → Teams (monitoring-min)                       | G      |
| 0.3 | Rehearsal passed: AWS prod dump → restore into `pg-rova` → migrations → app boots → smoke (fast-track)                       | SA     |
| 0.4 | `live/edge` cutover PR for `rova.qnsc.vn` reviewed, NOT merged: it adds the host — **no Access app on prod** (see 0.7)        | F      |
| 0.5 | `kv-qnsc-prod` holds every secret in section 1.3 (the provisioning script, names only)                                       | owner  |
| 0.6 | The prod image is published to GHCR and its `sha-<commit>` is recorded in the move log (section 1)                           | C / SA |
| 0.7 | **No Access on the prod host** (only dev hosts have one): `/readyz` and `/v1/scm/webhook/*` reach the API with no bypass needed | F      |
| 0.8 | RDS final manual snapshot taken and id recorded; AWS stack left as-is (rollback target, 72 h soak)                           | owner  |
| 0.9 | CI paused for the window: **no release tag is cut while it is open** (a tag deploys ECS prod)                                | SA     |

0.7: prod is NOT behind Cloudflare Access (ONPREM-PLAN §8.2; infra#260 adds DNS + Workers routes only).
The app authenticates; the edge adds the Free managed WAF and the zone rate limit on `/api/*`. So no bypass
apps are needed for `/readyz` or the SCM webhook, and the User Guide gate on prod is the Worker
(`guide-gate.worker.ts`) — it is the ONLY control there, not defence in depth. The smoke tests below
prove all three.

## 1. Which image goes live, and whether a release is needed

**No release tag.** On-prem takes the immutable `sha-<commit>` image that `GHCR · Publish` builds on
every merge to `main` (`.github/workflows/ghcr-publish.yml:1-20`: `ghcr.io/quynhonsemiconductor/rova-{api,worker,migrator}:sha-<commit>`,
amd64). The AWS deploy path is not involved: `backend-deploy.yml` only runs on tags, so **cutting
rova#622 (0.8.0) during the window would deploy ECS prod and run the AWS migrator against RDS** — do
not merge it until after the soak, when it is only a version bump. The web half of #622 is not needed
either; the SPA reaches prod through the Worker (section 1.2).

1.1 **Pick the commit**: `main`'s head after the last PR whose images you intend to run, recorded as
`sha-<12>` in the move log. That image already contains identity 8 (#718, #729, #719's backfill
wiring), Graph mail (#715, #758, #803), the placeholder guard (rova#727) and the Worker deploy
(rova#834). Confirm the run: `gh run list -w ghcr-publish.yml --limit 1`.

1.2 **SPA**: prod is served by the Worker `rova-prod-web`, not Pages. It is deployed only when the
repository variable `WEB_WORKER_PROD_ENABLED` is `true` and `workflow_dispatch` targets `production`
(`.github/workflows/web-deploy-worker.yml:16-17,57`), and the `production` environment must hold
`CLOUDFLARE_WORKERS_API_TOKEN`. One dispatch before the window proves the path; the edge route is
Terraform's.

1.3 **`kv-qnsc-prod` secret names** (per-value, dev shape): `rova-prod-cookie-secret`,
`rova-prod-csrf-secret`, `rova-prod-better-auth-secret` (API only), `rova-prod-platform-admin-emails`
(API only — the API refuses to boot without it, `apps/api/src/bootstrap/platform-admin-emails.ts:14`),
`rova-prod-entra-client-secret`, `rova-prod-storage-access-key-id`, `rova-prod-storage-secret-access-key`,
`rova-prod-db-app`, `rova-prod-db-worker`, `rova-prod-db-migrator`, `rova-prod-graph-cert`. Fresh
values, not copies. Env names in gitops `values/rova/prod.yaml`: `REDIS_URL` plain `redis://`, no
`SES_*`, `SQS_*`, `AWS_*` or CloudWatch value.

## 2. identity 8 on-prem: what the AWS script did that still applies

`scripts/owner/identity-v8-cutover.sh prod` assumes AWS (Secrets Manager read/write at
`rova/production/app`, a Pages secret, ECS task definitions). On-prem:

**Still applies (do it by hand / with the Entra blade; the script's own steps 2 and 4):**

- Entra sign-in app "Rova Prod": redirect URI **`https://rova.qnsc.vn/api/auth/callback/microsoft`**
  (the v8 path; keep the old `/v1/bff/callback` until day 7) and optional claims, ID token: **`email`
  and `upn`**. Without them staff sign-in is refused after the cutover
  (`identity-v8-cutover.md`, "Production", step 2).
- The **backfill committed by the migrator**: `IDENTITY_V8_BACKFILL=commit` on the migration job
  (`db/identity-v8/on-deploy.ts:8`), against the restored database, AFTER the migrations and BEFORE
  the API rolls. On AWS this was Terraform `identity_v8_backfill_on_deploy`; on-prem it is the
  gitops value on the migrate job. Remove it after the night: while set, every migrate re-runs the
  preflight against live data.

**AWS-only, skip:** the `better-auth-secret` and `edge-client-ip-secret` Secrets Manager writes, the
`EDGE_CLIENT_IP_SECRET` Pages secret (no Pages, no Function on-prem — the real visitor IP reaches the
API through the Tunnel), the tag/`go release` step, and the task-definition assertions. The secrets
still exist, as Key Vault values (1.3).

**Do NOT set `edge-client-ip-secret`/`EDGE_CLIENT_IP_SECRET` anywhere on-prem.** The Pages Function is
what needed it; the tunneled API sees the real address.

## 3. Migrations on the restored database

AWS prod's head is **before 0131**; current `main` is **0137** (`db/migrations`, journal verified by
`Migration upgrade path` in `Backend CI`). The restored database therefore gets 0131→0137 plus the v8
backfill. Watch:

- **0132** runs `work.backfill_lifecycle_dates()` and **RAISEs above 2,000,000 `work.activity_logs`
  rows** (`db/migrations/0132_story_lifecycle_dates.sql:70-71`). Count before the night.
- **0134** adds `report:export` to every workspace's admin role rows — an UPDATE over `access.system_roles`.
- **0136** creates the v8 tables (additive); **0137** re-states the runtime grants and default
  privileges for `rova_app`/`rova_worker`, deriving the schema list from ownership. On CNPG the
  migrator is `rova_migrator`, which owns the database and has **no CREATEROLE** — the fresh-database
  shape is proven by the `Fresh DB rebuild` job (`db/fresh-db/`, rova#832/#833), and the upgrade shape
  (old head → current) by `Migration upgrade path`. Both are required checks on `main`.
- The restored dump carries the OLD 0068 hash; `db/migrate.ts` reports it as the known post-apply edit
  (rova#833's allow-list) and continues. That line is expected; anything else in that report is not.

Run the migrator as its own step (the chart's migrate hook or a one-off Job on the migrator image)
with `DATABASE_URL` for `rova_migrator`, BEFORE the API is scaled from 0. A failure leaves the API at
0, which is the correct stop.

## 4. Graph mail

Must exist before the worker starts with `EMAIL_PROVIDER=graph`:

| What                             | Detail                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entra "Rova Prod Service" app    | certificate-only registration, adopted by `infra/live/identity/mail.tf` (`rova_prod`), consent for `User.Invite.All`                                |
| Key Vault `rova-prod-graph-cert` | one combined PEM (key + certificate), mounted into the **worker only**, `AZURE_CLIENT_CERTIFICATE_PATH`                                             |
| Exchange                         | `Application Mail.Send`, scope `noreply-rova`, assigned to the **Service** app; the sign-in app's assignment removed after the first delivered mail |
| gitops `values/rova/prod.yaml`   | `EMAIL_PROVIDER=graph`, `MAIL_GRAPH_SENDER=noreply-rova@qnsc.vn`, `MAIL_GRAPH_CLIENT_ID`                                                            |

**If mail is not ready, the safe fallback is the worker at 0, not a fake provider.** Invitations and
notifications are written to the outbox in the creating transaction; with no worker they stay
pending, and they send when it starts with Graph configured. Do **not** start the worker with
`EMAIL_PROVIDER=dev` to "unblock" the API: the dev provider logs instead of sending and marks the row
sent, so those invitations are lost and must be re-sent by hand (`workspace.resendInvitation`). The
worker is the only component that needs mail; the API, sign-in and attachments do not.

A worker that starts with Graph half-configured fails at boot rather than queueing (env schema for
`graph`, and rova#727 refuses unreplaced placeholders), so the failure is loud.

## 5. The night, in order

1. Announce the downtime (Teams). Freeze: API and worker at 0; no release tag.
2. RDS final snapshot (0.8). Record the id.
3. Dump → restore → verify: the data-move runbook (steps 4-7), `./verify.sh` must say
   `RESULT: source and target match` before anything writes.
4. Migrate: the migrator image with `IDENTITY_V8_BACKFILL=commit` (section 3). Then remove the flag
   from the values for later deploys.
5. Start API, then worker, from the pinned `sha-<commit>` (section 1), secrets from `kv-qnsc-prod`.
6. Merge the `live/edge` cutover PR (F). DNS flips to the `qnsc-apps` tunnel (no Access app on prod).
7. **Smoke** (below). Any failure: rollback, section 6.
8. Soak 72 h with the AWS stack untouched, then decommission (RUNBOOK "Decommission").

### Smoke tests

- **Sign-in**: `https://rova.qnsc.vn` → Entra → back on `/`, `__Host-rova.session_token` present;
  sign out and in again.
- **Workspace load**: a project list and one work item; activity shows the v8 user.
- **Attachments**: upload a file and download it (R2 through `STORAGE_ENDPOINT`, presigned URL),
  and one inline image.
- **Guest invite**: invite an external address; the mail arrives from `noreply-rova@qnsc.vn`
  (section 4). If this is the gate that fails, stop before step 6's DNS flip if you can.
- **SCM webhook**: `curl -s -o /dev/null -w '%{http_code}' -X POST https://rova.qnsc.vn/v1/scm/webhook/<provider>`
  → a 4xx from the API (bad signature), **never** a 302 to `cloudflareaccess.com` (0.7).
- **`/readyz`**: 200, database and cache green; the uptime alert sees it.
- **User Guide (US-119)**: signed out, `https://rova.qnsc.vn/guide/` redirects to
  `/login?returnTo=/guide/`; signed in it loads. The screenshots live under `/guide-assets/*`
  (production data): signed out, `curl -sI https://rova.qnsc.vn/guide-assets/<file>.png` must be a 302 to
  `/login`, never 200. This is the Worker gate (`apps/web/src/shared/lib/guide-gate.worker.ts`), not an Access policy.
- **UTC**: a new row's `created_at` is from the DB clock; a fresh log line's `time` is UTC.

## 6. Rollback

- **Before the DNS flip (step 6)**: nothing user-visible happened. Stop the on-prem API/worker, leave
  `pg-rova` for the next try, and the AWS stack is still there.
- **After the flip, before the soak ends**: revert the `live/edge` cutover PR (the AWS stack and RDS
  were never modified — the on-prem database is a copy). Rova comes back on AWS at the old head.
- **After the soak**: fix forward on-prem; the on-prem restore path is CNPG PITR from R2 or the
  verified dump, never AWS.
- The on-prem database may be ahead of AWS in schema (0131-0137, v8 backfill). A reverse dump does not
  load cleanly into the old image; treat post-GO loss as accepted (owner policy: fix forward).

## 7. What must never happen in the window

- A **release tag** while the window is open — it deploys ECS prod and runs the AWS migrator.
- A secret in a file, a shell history, a log or chat; values go in through stdin only.
- Migrations run after the API has started writing (the migrator owns the schema; API first would race
  the `report:export` grant and the v8 tables).
- The cutover merged in the same commit as an application change; each is its own reviewed apply.
- The worker started before its Graph credential exists (section 4).

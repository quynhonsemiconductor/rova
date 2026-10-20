# Runbook — take production RDS back to pre-launch sizing

**Executed on rally-prod 2026-07-29.** 100 GB → 30 GB, ~45 minutes end to end, no data
worth keeping lost. The three corrections that run produced are folded in below: the ECS
service names, applying through CI instead of locally, and step 8 — which did not exist
and without which the restored services cannot authenticate.

Applies the `rds` block in `infra/live/prod/main.tf` to the live instance: Multi-AZ
`db.t4g.small` with 100 GB and Enhanced Monitoring becomes single-AZ `db.t4g.micro`
with 30 GB and monitoring off.

**Why:** measured on 2026-07-28, that posture bills roughly **$101/mo** — $73 for the
instance (Multi-AZ doubles the hourly rate), $27.60 for storage (Multi-AZ bills the
mirrored volume, so 100 GB allocated is 200 GB paid), plus Enhanced Monitoring. Every
dollar buys durability and observability for a database with no users. Pre-launch it is
~$22/mo, a **$79/mo** difference — the largest single line on the account.

**This is explicitly reversible and explicitly temporary.** Instance class, Multi-AZ and
Enhanced Monitoring can be turned on in place at any time. **Storage cannot** — which is
why the shrink happens now.

Note what go-live actually did with those three: it kept all of them. `t4g.micro`,
single-AZ and `monitoring_interval = 0` each survived being costed against measured rates
and each carries a named signal that revokes it — see `docs/go-live-cost-delta.md` and
the note above the `rds` block in `infra/live/prod/main.tf`. So "flips back before the
first real user" was the earlier plan, not what happened; storage is the only item here
whose timing was ever forced.

---

> **Step 4 deletes the production database instance and every row in it.** It is correct
> only because production has no users. Run the row-count check in step 1 and stop if it
> shows anything you would miss. `deletion_protection = true` stays `true` in Terraform
> throughout — step 4 removes it with the CLI so no commit ever lands with production
> unprotected.

## Why storage needs a replace and the rest does not

`ModifyDBInstance` accepts an increase in `allocated_storage` and refuses a decrease.
A snapshot restore cannot land on a volume smaller than its snapshot either. So the
only way down is a new volume. Lowering the number in Terraform alone gives a plan that
looks clean and then fails:

```
Error: modifying RDS DB Instance (rally-prod): InvalidParameterCombination:
Invalid storage size for engine name postgres and storage type gp3: 30
```

Class, Multi-AZ and `monitoring_interval` are all in-place modifications, so if you only
wanted those you could stop after step 3 and skip the replace entirely.

## Steps

1. **Prove the database is empty.** No public route to the instance — use an ECS Exec
   session on a running api task, or a throwaway host in a private subnet.

   ```sql
   SELECT relname, n_live_tup
   FROM pg_stat_user_tables
   WHERE n_live_tup > 0
   ORDER BY n_live_tup DESC;
   ```

   Expect only `__drizzle_migrations` and the bootstrap workspace/role/permission rows.
   **Any real workspace, user, work item, attachment or audit row means stop.** After
   launch the only route down is a logical dump/restore — see the last section.

2. **Snapshot.** Cents, and the only way back.

   ```bash
   TS=$(date -u +%Y%m%d-%H%M)
   aws rds create-db-snapshot \
     --db-instance-identifier rally-prod \
     --db-snapshot-identifier "rally-prod-preshrink-$TS" \
     --region ap-southeast-1

   aws rds wait db-snapshot-available \
     --db-snapshot-identifier "rally-prod-preshrink-$TS" \
     --region ap-southeast-1
   ```

3. **Stop writes.** Scale both services to zero so nothing reconnects mid-flight.

   ```bash
   aws ecs update-service --cluster rally-prod --service api    --desired-count 0 --region ap-southeast-1
   aws ecs update-service --cluster rally-prod --service worker --desired-count 0 --region ap-southeast-1

   aws ecs wait services-stable --cluster rally-prod \
     --services api worker --region ap-southeast-1
   ```

   Terraform still declares `desired_count = 1`, so step 6's apply restores it. The
   scale-down is operational, not committed — and `ensure_rds` in qnsc-ci's
   backend-deploy reusable restores any service the cost-saver left at zero anyway.

4. **Delete the instance.**

   ```bash
   aws rds modify-db-instance \
     --db-instance-identifier rally-prod \
     --no-deletion-protection --apply-immediately \
     --region ap-southeast-1

   aws rds delete-db-instance \
     --db-instance-identifier rally-prod \
     --skip-final-snapshot \
     --region ap-southeast-1

   aws rds wait db-instance-deleted \
     --db-instance-identifier rally-prod \
     --region ap-southeast-1
   ```

   `--skip-final-snapshot` is safe here **only** because step 2 already took one. Verify
   that snapshot exists before running this.

5. **Drop it from state**, so the next apply creates rather than tries to modify:

   ```bash
   cd infra/live/prod
   tofu init
   tofu state rm 'module.stack.module.rds.aws_db_instance.this'
   ```

6. **Apply.** The code already carries the pre-launch values. Review the plan before
   confirming: it must add exactly one `aws_db_instance` and change nothing else. If it
   wants to touch `module.stack.module.cache`, the ECS cluster or the secrets, stop —
   something else drifted and this is no longer the change you reviewed.

   Apply through CI, not locally. Two reasons: the prod stack needs
   `TF_VAR_cloudflare_api_token`, which only CI holds, and a local apply bypasses the
   `production` environment's required reviewer — the gate exists precisely for changes
   like this one.

   `apply-prod` is `if: github.ref_type == 'tag'`, so dispatch it against the CURRENT
   RELEASE TAG rather than a branch; a `main` dispatch silently skips the prod job.

   ```bash
   gh workflow run infra-apply.yml --repo quynhonsemiconductor/rova --ref vX.Y.Z
   ```

   Then approve `apply-prod` on the run. Review the plan in its log before approving: it
   must CREATE exactly one `aws_db_instance`, REPLACE the three task definitions, and
   update the two `execution_secrets` policies in place — the task definitions and
   policies move because the managed master secret ARN changes. Anything touching
   `module.stack.module.cache`, the ECS cluster or `module.secrets` means something else
   drifted; stop.

   The new instance comes up empty with a **new** managed master secret; the same apply
   re-registers the task definitions against that ARN. Terraform also restores
   `deletion_protection = true`, so the CLI removal in step 4 never reaches a commit.

7. **Migrate**, with the task CI uses so the schema comes from `db/migrations/*.sql`:

   ```bash
   aws ecs run-task \
     --cluster rally-prod \
     --task-definition "$(tofu output -raw ecs_migrator_task_def)" \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$(tofu output -json private_subnet_ids | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)))')],securityGroups=[$(tofu output -raw sg_app_id)],assignPublicIp=DISABLED}" \
     --region ap-southeast-1
   ```

   Tail `/ecs/rally-prod-migrator` until it exits 0. It runs the tenant bootstrap seed
   and **not** the demo seed — `seed_on_deploy = false` in production, and that stays.

8. **Re-apply the least-privilege role passwords.** Migration 0068 recreates
   `rally_app` and `rally_worker` on the new instance as **NOLOGIN**, and the Secrets
   Manager passwords were only ever applied to the OLD database. So while
   `db_least_privilege = true` the api and worker cannot authenticate at all — every
   task fails `28P01`, the health check fails and the deploy rolls back.

   This step is easy to miss because step 7 exits 0 and the database looks healthy.

   ```bash
   aws ecs run-task \
     --cluster rally-prod \
     --task-definition rally-prod-migrator \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-ids>],securityGroups=[<migrator-sg>],assignPublicIp=DISABLED}" \
     --overrides '{"containerOverrides":[{"name":"migrator","command":["node","dist/db/enable-least-privilege-roles.js"]}]}' \
     --region ap-southeast-1
   ```

   Expect two `✅` lines in `/ecs/rally-prod-migrator`. See
   `docs/runbooks/db-role-least-privilege.md`.

9. **Bring the services back** and confirm.

   ```bash
   tofu apply    # restores desired_count = 1
   aws ecs wait services-stable --cluster rally-prod \
     --services api worker --region ap-southeast-1

   aws rds describe-db-instances --db-instance-identifier rally-prod \
     --region ap-southeast-1 \
     --query 'DBInstances[0].[DBInstanceClass,AllocatedStorage,MultiAZ,MonitoringInterval,DeletionProtection]'
   ```

   Expected: `["db.t4g.micro", 30, false, 0, true]`. Deletion protection is back on
   because step 6 created the instance from code that never stopped asking for it —
   confirm the `true` rather than assuming it.

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://rally-api.qnsc.vn/v1/healthz
   ```

   Then sign in through Entra at `https://rally.qnsc.vn`, create and delete one throwaway
   work item, and confirm the notification bell updates live — that last step exercises
   the api↔worker pub/sub path over the cache, which is the piece most likely to look
   fine and be broken.

9. **Clean up** after 30 days:

   ```bash
   aws rds delete-db-snapshot --db-snapshot-identifier "rally-prod-preshrink-$TS" \
     --region ap-southeast-1
   ```

## Rollback

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier rally-prod \
  --db-snapshot-identifier "rally-prod-preshrink-$TS" \
  --region ap-southeast-1
```

It comes back at 100 GB — a snapshot restore cannot shrink, which is the whole reason
this runbook exists. Revert the `rds` block to the Multi-AZ values so the next plan is
empty.

## At go-live

Flip the four values in the checklist above the `rds` block and apply. Class, Multi-AZ
and monitoring all apply **in place**; expect a brief failover during the Multi-AZ
conversion and a restart for the class change, so do it in a window. Storage stays at 30
GB and autoscales to 500 on demand.

## After launch, if storage ever needs to come down again

Not this procedure. `pg_dump -Fc` from the old instance, replace it at the smaller size,
`pg_restore --no-owner --no-privileges` into the new one, with both services scaled to
zero throughout. `--no-owner --no-privileges` matters: the new instance has a fresh
master role and without them every object errors on ownership. Longer, riskier, and
avoidable by never over-allocating — which is why the comment in
`infra/live/prod/main.tf` says to treat an increase as permanent.

## Develop

`infra/live/develop/main.tf` allocates 20 GB, the RDS gp3 minimum. Nothing to shrink.

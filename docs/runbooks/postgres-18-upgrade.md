# PostgreSQL 17 → 18 and Valkey 7.2 → 8.1: rova production

Status: DRAFT. Not for merge until the owner names the release window. Merging applies `infra/live/prod`.

Scope, in one window:
- `rova-prod` RDS: PostgreSQL 17.9 → 18.x in place (major pin `18`, auto minor upgrades on).
- `rova-prod-cache-001`: Valkey 7.2.6 → 8.1 in place (node mode). `apply_immediately` is true, so the upgrade starts at apply.

Downtime is accepted for both. The two changes go in one window so the database and cache move together.

Owner: decide the window, announce it, and run every command with `--profile qnsc-admin` in your own terminal. The default profile on this machine is another account.

## 0. Preconditions

- Develop upgrade verified (rova-develop: `/v1/readyz` postgres and valkey up, sign-in, worker, identity invariant).
- #747 (pins), #749 (stack wiring and develop), and tf-modules `rds-v2.4.0` / `cache-v1.2.0` released.
- Read-only check (name the profile):
  ```
  aws rds describe-db-instances --profile qnsc-admin --region ap-southeast-1 --db-instance-identifier rova-prod --query 'DBInstances[0].[EngineVersion,DBParameterGroups[0].DBParameterGroupName,length(PendingModifiedValues)]'
  aws elasticache describe-cache-clusters --profile qnsc-admin --region ap-southeast-1 --cache-cluster-id rova-prod-cache-001 --query 'CacheClusters[0].[EngineVersion,CacheParameterGroup.CacheParameterGroupName,CacheClusterStatus]'
  ```

## 1. Manual snapshots (mandatory, before any change)

```
aws rds create-db-snapshot --profile qnsc-admin --region ap-southeast-1 --db-instance-identifier rova-prod --db-snapshot-identifier rova-prod-pre-pg18-$(date -u +%Y%m%d%H%M)
aws rds wait db-snapshot-available --profile qnsc-admin --region ap-southeast-1 --db-snapshot-identifier <the name above>
```

The cache has no snapshot step here: it holds sessions, rate limits and locks, not the system of record. Record the RDS snapshot identifier in the release notes. It is the rollback.

## 2. Plan, read it, then apply

```
AWS_PROFILE=qnsc-admin tofu -chdir=infra/live/prod plan -out=prod.tfplan
AWS_PROFILE=qnsc-admin tofu -chdir=infra/live/prod show prod.tfplan
```

Expected:
- `module.rds.aws_db_parameter_group.this[0]` replaced: `rova-prod-pg17` → `rova-prod-pg18`, family `postgres17` → `postgres18`, create-before-destroy.
- `module.rds.aws_db_instance.this`: in-place, `engine_version` 17.9 → 18.x, both flags true.
- `module.cache[0].aws_elasticache_replication_group.this[0]`: in-place, `engine_version` 7.2.6 → 8.1.x. Stop if it shows `must be replaced`: the cache must not be recreated.
- Stop, and do not apply, if the RDS instance or the replication group is `must be replaced`, or anything is destroyed besides the old parameter group.

Apply (inside the window): `AWS_PROFILE=qnsc-admin tofu -chdir=infra/live/prod apply prod.tfplan`.

## 3. Verify

- RDS: 18.x, `rova-prod-pg18`, no pending values (command in section 0).
- Cache: 8.1.x, status available (command in section 0).
- Migrator runs clean on 18. `/v1/readyz` reports postgres and valkey up. Sign-in, worker, identity invariant.
- Smoke test the paths named in the release notes.

## 4. Rollback

- Database: an in-place major upgrade cannot be undone on the same instance. Restore the snapshot from section 1 to a new instance, then repoint `rova-prod` (owner-run, local apply with `-replace` if needed, same style as rova #729).
- Cache: ElastiCache does not downgrade engines. A cache rollback is a new node with 7.2 and the sessions lost; the product fails open on the rate limiter and denylist while it is absent. Prefer fixing forward.

## 5. Follow-up

A PR sets `allow_major_version_upgrade` and `apply_immediately` back to false (RDS) and `apply_immediately` back to false (cache). Not part of this change.

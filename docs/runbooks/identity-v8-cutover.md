# identity v8: the cutover, and the way back

rova signs people in with `@quynhonsemiconductor/identity` 8 (Better Auth, the `staff` preset, Microsoft Entra, B2B guests for vendors)
instead of the v7 BFF session. This page is the operator's half: what to prepare, the order of the cutover on **develop** and then
**production**, how to prove it worked, and how to undo it. The data half (the tables, the backfill) is
[identity-v8-data-model.md](identity-v8-data-model.md).

**The cutover change does not touch a v7 table.** The v7 tables (`identity.auth_sessions`, `sso_identities`, `sso_connections`, ...) are frozen at
day 7 and dropped at day 30, in two later changes that do not gate the cutover. Until the drop, rollback is a redeploy.

## The order of everything (read this first)

Three changes, in this order. Reversing 1 and 3 is an outage.

| #   | Change                                                                                    | What it does                                                                           | Why it is first/last                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **rova#719** (merged): the backfill in the migrator image (+ re-run fixes, `mirror-bans`) | Nothing at runtime. Puts `db/identity-v8/*.sql` into the image the backfill runs from. | The backfill must be dry-run and **committed before** the v8 API serves. With empty v8 tables every existing user's sign-in is refused (`PROFILE_ID_MISMATCH`, fail-closed) until it commits, and a dry run that raises on real data (the seeded admin, say) extends that outage. |
| 2   | **Your steps**: secret, Entra redirect URI, dry run, **commit the backfill**              | See "What you prepare" and "The cutover".                                              | Additive: the backfill writes only `identity."user"` and `identity.account`.                                                                                                                                                                                                      |
| 3   | **rova#718**: the cutover                                                                 | The v8 API, worker and web.                                                            | Merge only when steps 1 and 2 are done on that environment.                                                                                                                                                                                                                       |

**Production is cut in the same release as develop, shortly after develop is verified**, with an announced downtime. Production's migrator image (and its API, worker and SPA) only come from a release tag, so the cutover is a tag cut after the flags below are true on `main` and applied. The reusable deploy workflows refuse a tag, before the migrator and before any publish, while `infra/live/prod/main.tf` lacks either of

- `better_auth_secret_set = true`: the v8 API cannot start without `BETTER_AUTH_SECRET`; the circuit breaker would roll the API back to v7, the worker would
  stay v8, and the SPA (published by the web deploy of the same tag) would already be v8 against a v7 API;
- `edge_client_ip_secret_set = true`: without it the API falls back to `cf-connecting-ip`, which behind the Pages Function is **one** Cloudflare address for every
  visitor, so the address-keyed rate limit (1,200 requests/min) and identity's own sign-in limits become **company-wide** on the morning everyone signs in again.

The cutover release is the first tag cut after both flags are true. Rollback after it is in "Rollback" below.

A tag's web deploy now waits for the **same tag's** backend deploy (`wait-for-backend` in `web-deploy.yml`), so the SPA of a release never goes
live ahead of its API, or stays live if that API is rolled back. On **develop** the two deploys are independent (a push to `main`); expect up to ~45
minutes in which the SPA and the API are on different sides of the cutover. Announce it as a maintenance window, and do the verification after both
are green.

## What changes for people

- Sign-in is `POST /api/auth/sign-in/social` -> Microsoft -> `/api/auth/callback/microsoft`, same-origin with the SPA (a second Pages Function,
  `apps/web/functions/api/auth/[[path]].ts`). The cookie is `__Host-rova.session_token` in production (`__Secure-` elsewhere); it was `__Host-rova_session`.
  `SameSite=Lax` stays what identity sets: the Microsoft callback is a cross-site top-level navigation, so a `Strict` state cookie would not come back.
- **Everyone signs in once.** v7 sessions are not migrated.
- The workspace switch is `POST /v1/auth/switch-workspace`; "who am I" is `GET /v1/auth/me` (both replace `/v1/bff/*`).
- API tokens (`rly_...`) keep working unchanged: the table is untouched and the credential is the same. A **banned** user's token is refused, and so is
  one whose owner has no identity user yet (they sign in once and it works again).
- A vendor signs in as a **B2B guest** of the company tenant. They are admitted only with a live invitation (by directory object when the invitation
  carries one, by address otherwise) or a workspace seat they still hold; a guest is never created by just-in-time provisioning, and a profile alone is not a seat.
  Staff addresses follow `SSO_JIT_ENABLED` (invite-only in every deployed environment).

## What you prepare (once per environment)

| #   | Who   | What                                                                                                                                                                                                                                                      | Proof                                                                                             |
| --- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | owner | Entra app registration (the **sign-in** app, single-tenant): add the redirect URI `https://<app domain>/api/auth/callback/microsoft`. **Keep** the v7 one (`/v1/bff/callback`) until the day-7 change.                                                    | the app's Authentication blade lists both                                                         |
| 2   | owner | The registration emits the `email` and `upn` claims in the ID token (optional claims). The `staff` preset checks the address AND the UPN against `SSO_ALLOWED_EMAIL_DOMAINS`.                                                                             | `Sign-in logs` show a successful token with both; a test sign-in succeeds on develop              |
| 3   | owner | **Put the key into the bundle and prove the KEY is there** (below). The deploy preflight proves only that the bundle has a version; a missing key passes it and fails at task start, after the migrator ran.                                              | `jq -e 'has("better-auth-secret")'` prints `true`                                                 |
| 4   | owner | Set `better_auth_secret_set = true` in `infra/live/<env>/main.tf` and apply. develop's is already `true` in #718: **do step 3 before merging #718.** For production, set it `true` in the release change (the script's release step checks it on `main`). | `tofu plan` shows the API task gaining `BETTER_AUTH_SECRET`, nothing else                         |
| 5   | owner | Cloudflare Pages: `API_ORIGIN` and `EDGE_CLIENT_IP_SECRET` are already set for `/v1/*`; the new `/api/auth/*` Function reuses both.                                                                                                                       | the web deploy lists `functions/api/auth`                                                         |
| 6   | owner | **Production only:** `edge_client_ip_secret_set = true` (the key the Pages Function signs the visitor address with; docs/runbooks/edge-client-ip.md, "PRODUCTION"). The tag guard refuses a prod tag without it. Develop has it.                          | a request through the Pages Function logs the visitor's real address; `tofu plan` shows no change |

The worker is **not** given `BETTER_AUTH_SECRET`. Until PR 4 (below) the worker's Graph guest invite still uses `ENTRA_CLIENT_SECRET`.

### Step 3 in commands (the value is never printed)

```sh
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
SECRET_ID=rova/develop/app            # production: the bundle named in infra/live/prod/main.tf (rova/production/app)

# 1. is the key already there? (prints only true/false)
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text | jq -e 'has("better-auth-secret")'

# 2. if false: generate it into the environment and add it to the bundle (read-modify-write; the value goes through a pipe, not argv)
export KEY="$(openssl rand -base64 48)"
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text \
  | python3 -c 'import json,os,sys; d=json.load(sys.stdin); d["better-auth-secret"]=os.environ["KEY"]; print(json.dumps(d))' \
  | aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string file:///dev/stdin
unset KEY

# 3. prove it, again without printing it: the key exists and is at least 32 characters
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text \
  | jq -e '(.["better-auth-secret"] | length) >= 32'
```

Rotating the value later signs everyone out (nothing else); do it the same way and redeploy.

## The cutover, in order (develop first, then production)

**Interactive script:** `scripts/owner/identity-v8-cutover.sh` runs the develop steps (`develop`) and the production steps (`prod`, see "Production"), one confirmed write at a time.

**The script is in #729 and is not merged yet.** Until it merges, run it from the #729 branch, in a worktree next to this checkout: `git worktree add ../wt729 owner/identity-v8-develop-cutover`, then `bash ../wt729/scripts/owner/identity-v8-cutover.sh develop`. The stub tests for the production path are `bash ../wt729/scripts/owner/test/run.sh`.

Steps 1-3 are additive and happen **before** #718 deploys; 4-6 are the window. Production runs the same steps in one release, shortly after develop is verified, with an announced downtime and a database snapshot before any write (see "Production").

1. **Dry run of the backfill**, from the migrator image (it has the SQL since #719). A one-off ECS task on the migrator's task definition, with the
   command overridden. **First verify what that task definition runs**: its image must be a build of `main` that contains #719 (merge commit `4744d1b3`), or the
   command fails with `Cannot find module` / `ENOENT backfill.sql`:

   ```sh
   aws ecs describe-task-definition --task-definition "$TASKDEF" --query 'taskDefinition.containerDefinitions[?name==`migrator`].image' --output text
   # -> .../rova-migrator:<tag>. On develop the tag is the commit it was built from: `git merge-base --is-ancestor 4744d1b3 <that commit>` must succeed.
   ```

Names below are `rova-<env_slug>`. They come from `infra/modules/stack` (`name = "${product}-${env_slug}"`: cluster `rova-develop`, services `api` and `worker` (their task-definition families are `rova-develop-api` and `rova-develop-worker`), migrator family `rova-develop-migrator`, API log group `/ecs/rova-develop-api`). The owner script confirms them against the account before any write.

```sh
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1 ENV_SLUG=develop        # production: prod
CLUSTER=rova-$ENV_SLUG TASKDEF=rova-$ENV_SLUG-migrator

# discovery: the cluster, its services, and the network the API runs in (the migrator task needs the same subnets and a security group
# that can reach the database, i.e. the API's)
aws ecs list-clusters --query 'clusterArns' --output text
aws ecs list-services --cluster "$CLUSTER" --output text
aws ecs describe-services --cluster "$CLUSTER" --services "$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[?ends_with(@, `/api`)]|[0]' --output text)" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json   # -> subnets, securityGroups
```

```sh
SUBNETS='subnet-aaa,subnet-bbb' SGS='sg-xxx'     # from the lines above
TENANT_ID="<ENTRA_TENANT_ID>"                    # the sign-in app's tenant (var.entra_tenant_id)

run_migrator() {   # run_migrator '<json array of the command>'
  aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SGS],assignPublicIp=DISABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"migrator\",\"command\":$1}]}" \
    --query 'tasks[0].taskArn' --output text
}
TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","backfill","--tenant-id","'"$TENANT_ID"'","--staff-domains","qnsc.vn"]')
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].{exit:exitCode,reason:reason}'
# the output: the migrator's log group, newest stream of the task
aws logs tail "/ecs/$(echo "$TASKDEF")" --since 15m
```

Exit code `0` and `DRY RUN: every preflight check and assertion passed` is a pass. A non-zero exit is a `RAISE` naming ids and counts (never addresses). Every
raise is a decision for the owner, not a retry: more than one Entra identity per user, a live user that is neither an Entra user nor a staff address,
an `sso_connections` row beyond the home directory connection and the `shared` guest gate (partner SSO is deferred), two users sharing a lower-cased
address. Fix the data in v7, then dry-run again. **A raise on develop's seeded data (e.g. `admin@qnsc.dev`: no Entra identity and an address off `qnsc.vn`) is
the reason this is done before #718, not after**: fix or remove the fixture, dry-run again, until it passes.

2. **Commit the backfill** (`<database name>` is `DATABASE_NAME` in the migrator task definition's environment, i.e. `module.rds.db_name`: `aws ecs describe-task-definition --task-definition "$TASKDEF" --query 'taskDefinition.containerDefinitions[?name==`migrator`].environment[?name==`DATABASE_NAME`].value' --output text`; additive: it reads v7 and writes only `identity."user"` and `identity.account`):

   ```sh
   TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","backfill","--tenant-id","'"$TENANT_ID"'","--staff-domains","qnsc.vn","--commit","--database","<database name>"]')
   aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
   aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode'
   ```

   `--commit` refuses unless `--database` names the database the connection is on. It is idempotent and re-runnable: a re-run carries renames and avatars,
   bans anyone v7 has inactive or suspended, bans (never deletes) a user deleted in v7 since, and **never lifts a ban placed in v8**.

3. **Check the invariant** (both queries must return no rows): the one in identity-v8-data-model.md, "`identity.users` stays".

4. **Deploy:** the API, the worker and the web. #718 is merged: on develop the push to `main` deploys it; on production the release tag does. The tag guard refuses a tag until `infra/live/prod/main.tf` has the flags (`better_auth_secret_set`, `edge_client_ip_secret_set`) set to `true`.
   The API starts only if `BETTER_AUTH_SECRET` is present: a missing secret is a task that cannot start, the previous task keeps serving until the new one is healthy.

5. **Re-run the backfill** once the deploy has settled (idempotent): it picks up anyone v7 created while the rolling deploy overlapped, and it passes after a v8
   guest signed in. Those people would sign in again anyway; this keeps the id invariant true for them.

6. **Verify** (develop: you; production: you and one other person), in a private window:

   - [ ] Staff sign-in lands in the home workspace; `GET /v1/auth/me` returns the same `id` as before the cutover for that person (the profile id did not change).
   - [ ] A workspace switch works for a member of two workspaces and is refused (403) for a workspace they are not in, and for one that was deleted. Removing the member takes the workspace away on their open session within a second.
   - [ ] A vendor with a live invitation signs in as a guest and sees only what their invitation granted; a guest with none, or one removed from the workspace, gets `?error=STAFF_SIGN_IN_REFUSED` on the login page.
   - [ ] An API token minted before the cutover authenticates; revoking it returns 401. Banning the owner (`setUserBanned`) returns 401 for the token too. 301 requests with made-up `rly_` tokens from one address end in `429`.
   - [ ] A user suspended/removed from the workspace cannot reach it (zero permissions), and their API tokens are revoked (unchanged behaviour).
   - [ ] Sign out, and "sign out everywhere" (`POST /v1/auth/logout-all`), end the session. `GET /api/auth/get-session` carries no `token`.
   - [ ] No `identity.profile_id_mismatch`, `identity.staff_sign_in_refused` (other than the refusals you caused), `identity.auth_handler_threw` or `identity.context_cache_stale` log line. `sign_in.failure` is a metric; the `rate_limit` fail-open alarm stays quiet.

## Production: how it differs from the develop steps above

Prod's migrator image only comes from a release tag. The release is therefore the gate, and there is no dry run before it: the image running on
production today has no migration 0136, so it could not pass one. `bash scripts/owner/identity-v8-cutover.sh prod` walks the steps below.

### (a) Migrations 0131-0136 and the on-deploy gate

- The release carries migrations 0131 to 0136 and the identity v8 SQL (`db/identity-v8/*.sql`, since #719). There is no dry run before the release: the image on
  production today has no migration 0136. The release's on-deploy preflight is the gate. A RAISE fails the migrator task, the deploy stops, and the v7 tasks keep
  serving.
- What the migrations change in data, from `db/migrations` on `main`:
  - **0132** (story lifecycle dates) runs `work.backfill_lifecycle_dates()`. It UPDATEs `work.work_items` and `work.tasks`, dating their lifecycle columns from
    `work.activity_logs`. It has an OPS GATE: it RAISEs when `work.activity_logs` holds more than 2,000,000 rows. The release script counts those rows first and
    stops above 2,000,000 (`check_activity_rows`). 0132 also replaces two triggers, `trg_stamp_story_lifecycle_dates` and `trg_stamp_task_lifecycle_dates`.
  - **0134** (`report:export`) UPDATEs `access.system_roles`. It adds the `report:export` permission to the `workspace_admin` and `project_admin` rows of every
    workspace. Existing admins gain CSV export. Project Members do not get it.
  - **0131, 0133, 0135, 0136** do not drop, truncate or delete data (a grep of `DROP`, `TRUNCATE`, `DELETE FROM` and `RENAME` over 0131 to 0136 finds only the two
    trigger replacements in 0132 and a comment in 0133). 0136 creates the identity v8 tables, which the v7 image does not read. Check the diff yourself before the
    release: `git diff <the previous release tag> <the new tag> -- db/migrations`.
- The snapshot the release takes first is the restore point for data (Rollback, C).

### (b) The cutover tag's migrator commits the backfill itself

The reusable deploy (`quynhonsemiconductor/ci` `backend-deploy.yml`) runs the migrator and only then rolls the API; a migrator that exits non-zero stops the
deploy and **the v7 tasks keep serving**. The migrator therefore runs the backfill, committed, **after the migrations and before the API rolls**, when its task
definition carries `IDENTITY_V8_BACKFILL=commit` (`db/identity-v8/on-deploy.ts`, called from `db/migrate.ts`). It is **opt-in per environment**:

- Terraform `identity_v8_backfill_on_deploy` (default `false`) sets that variable on the migrator task definition. **develop leaves it `false`** and runs the
  backfill by hand (steps 1-2 above). Production sets it **`true` only in the cutover change**, which is the same change that sets `better_auth_secret_set = true`
  and (if not already) `edge_client_ip_secret_set = true` in `infra/live/prod/main.tf`; that change's apply precedes the tag, as for any infra change.
- Any preflight `RAISE` or assertion fails the migrator task, so the deploy fails and nothing has changed for users. The backfill is additive and idempotent, so a
  retry after fixing the data is safe.
- **The change after the cutover sets it back to `false`.** While it is `true`, every deploy re-runs the preflight against live data and a new outsider row could
  fail an unrelated release.

Cutover sequence on production, in order (the script walks it):

1. **Retention:** the script asserts that automated backups keep at least 7 days.
2. **Secret and Entra:** `better-auth-secret` into `rova/production/app`; the redirect URI and the optional claims `email` and `upn` on the production sign-in app.
3. **Edge secret** (`docs/runbooks/edge-client-ip.md`): one generated value, set as the Pages secret `EDGE_CLIENT_IP_SECRET` on `rova-prod-web` and as
   `edge-client-ip-secret` in `rova/production/app`. The script refuses if either already exists, because the Pages value cannot be read back. It must exist
   before the release: the Function answers 500 without it.
4. **Flags:** `better_auth_secret_set`, `edge_client_ip_secret_set` and `identity_v8_backfill_on_deploy` all `true` in `infra/live/prod/main.tf`, merged to `main`.
   The tag deploy waits for the prod apply, so the flags must be merged before the release.
5. **Announce** the downtime. The script asks, then takes a **fresh manual snapshot** of `rova-prod` and waits until it is `available`. The name is saved.
6. **Release:** the SA merges the release-please PR (the owner says go release). The script finds the release tag on `origin/main` and saves it. It then waits for
   that tag's deploy: the backend deploy migrates, commits the backfill and rolls the API; the web deploy waits for it. The script checks that the live API runs
   that tag's build, injects the secret, and that the invariant holds.
7. **Verify:** the checklist, you first and then a second person. Then the follow-up change sets `identity_v8_backfill_on_deploy` back to `false`.

Rollback is in "Rollback" below (C is the snapshot restore).

### The web deploy of a prod tag can time out waiting for the backend

`wait-for-backend` allows 6 hours: the backend deploy itself waits for apply-prod and the `production` environment's required reviewer. If it still expires, the
web job fails and the SPA is **not** published (the safe direction: the previous SPA keeps serving against the new API for a while). **Re-run the web jobs once the
backend deploy is green** (Actions -> Web - Deploy -> the tag's run -> Re-run all jobs). Never publish the SPA by hand ahead of the API.

## Rollback

Until the v7 tables are dropped (the day-30 change), nothing in the database has to be undone **except the bans** (step 1). **A is the default rollback.** The v8 tables are additive, so v7 runs on them. B makes A durable. C restores the data from the snapshot: use it **only for data corruption**, because it loses writes (see C).

**Before either: mirror the bans** (v8-only bans would otherwise be silently lifted, because the v7 image reads `identity.users.status`, not identity 8's `banned`):

```sh
TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","mirror-bans"]')                                   # dry run: prints the counts
TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","mirror-bans","--commit","--database","<database name>"]')
```

**A. Fast (minutes): put the previous task definitions back, and the previous SPA.** For the API and the worker (replace `<prev>` with the revision that was live before the cutover; read it from `aws ecs list-task-definitions --family-prefix rova-$ENV_SLUG-api --sort DESC`):

```sh
aws ecs update-service --cluster "$CLUSTER" --service api    --task-definition rova-$ENV_SLUG-api:<prev>    --force-new-deployment
aws ecs update-service --cluster "$CLUSTER" --service worker --task-definition rova-$ENV_SLUG-worker:<prev> --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services api worker
```

then Cloudflare Pages: Workers & Pages -> `rova-<env>-web` -> Deployments -> the deployment before the cutover -> **Rollback to this deployment**. Do the SPA
and the API together: a v8 SPA against a v7 API (or the reverse) cannot sign anyone in. This path leaves Terraform's desired state ahead of the running
state; the **next** deploy re-registers the current definition, so follow it with path B the same day. The previous task definitions need
`JWT_PRIVATE_KEY` and `ENTRA_REDIRECT_URI`: they are still bound on purpose.

**B. Durable (an hour): revert the merge.** `git revert -m 1 <the #718 merge commit>` in a PR titled `revert: identity 8 cutover`, merge it; develop deploys
on merge and production on the next tag (the revert also removes the tag guard, since the guard belongs to #718). Keep `better_auth_secret_set` as is.

**C. Restore the data from the PRE snapshot. Data corruption only.** A does not touch data. C does, and it costs:

- The replace deletes the current `rova-prod` instance. Its automated backups and point-in-time recovery go with it (the module does not set `delete_automated_backups`, so the provider default applies). After C, the only backups are `PRE_SNAPSHOT` and the forensic snapshot from C1.
- Every write after `PRE_SNAPSHOT` is lost, for every user, including everything written since the release started.
- The replacement has a NEW endpoint address (the identifier stays `rova-prod`). The stack builds `DATABASE_HOST` from `module.rds`, so the services follow the apply.
- C does not roll back code. C4 and C5 do that.

Owner-run from a local machine (the local path, C3(ii)). The Infrastructure · Apply workflow has no replace input, and it is not used for this.

Module facts (`rds-v2.3.0`, `modules/rds/main.tf`): `snapshot_identifier` is read only at CREATE (`ignore_changes`), so the instance must be replaced explicitly with `-replace`. `skip_final_snapshot` defaults to `!deletion_protection`, so a final snapshot needs an explicit `skip_final_snapshot = false`; the final snapshot is named `rova-prod-final`. `image_tag` and `identity_v8_backfill_on_deploy` are root variables: pass them on the command line.

Use a branch `restore/rova-prod-<date>` for the `infra/live/prod/main.tf` edits in C2 and C3. Open the PR after the apply, as the record.

1. **C0. Pre-checks. Stop if any one fails.**

   ```sh
   export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
   PRE=$(grep '^PRE_SNAPSHOT=' ~/.local/state/rova-identity-v8/prod-state.env | cut -d= -f2)
   TAG_PRE=$(grep '^TAG_BEFORE=' ~/.local/state/rova-identity-v8/prod-state.env | cut -d= -f2)
   aws rds describe-db-snapshots --db-snapshot-identifier "$PRE" --query 'DBSnapshots[0].Status' --output text          # must print: available
   aws rds describe-db-snapshots --db-snapshot-identifier rova-prod-final --query 'DBSnapshots[0].Status' --output text  # must fail: DBSnapshotNotFound
   echo "$TAG_PRE"                                                                                                       # the last release before the cutover (the v7 build)
   ```

   If `rova-prod-final` exists (an earlier attempt), stop. The replace fails on the name. Rename or delete it only when the owner says so.

2. **C1. A forensic snapshot of the failed state.** Do this first. It is the only copy of the state before C.

   ```sh
   FORENSICS="rova-prod-forensics-$(date -u +%Y%m%d-%H%M)"
   aws rds create-db-snapshot --db-instance-identifier rova-prod --db-snapshot-identifier "$FORENSICS"
   aws rds wait db-snapshot-available --db-snapshot-identifier "$FORENSICS"
   ```

3. **C2. Deletion protection off, in its own apply.** On the branch, `infra/live/prod/main.tf`, the `rds` object: `deletion_protection = false` and nothing else.

   ```sh
   cd infra/live/prod
   tofu plan -out=unprotect.tfplan
   tofu show -no-color unprotect.tfplan | grep -E '^  # '     # must list one change: the instance, in place (~ deletion_protection)
   tofu apply unprotect.tfplan
   ```

   If the plan lists anything else, stop.

4. **C3. The replace.** On the branch, the same `rds` object also gets `skip_final_snapshot = false` and `snapshot_identifier = "<PRE>"` (the value of `$PRE` from C0). Then:

   ```sh
   tofu plan -replace='module.stack.module.rds.aws_db_instance.this' \
     -var image_tag="$TAG_PRE" \
     -var identity_v8_backfill_on_deploy=false \
     -out=restore.tfplan
   tofu show -no-color restore.tfplan | grep -E '^  # '
   ```

   The plan must show exactly these, and nothing else:

   - `module.stack.module.rds.aws_db_instance.this` replaced (`-/+`), `identifier` unchanged, a new `address`;
   - the RDS-managed master secret: a new secret ARN, and the IAM policy and the task definitions that read it;
   - the parameter group re-attached to the replacement;
   - the api, worker and migrator task definitions, as new revisions with the image tag `$TAG_PRE` (the v7 build).

   **Stop, and do not apply, if the plan shows:**

   - any change outside that list: DNS, Pages, edge, mail identity, certificate, or any other resource;
   - the instance updated in place instead of replaced, or a second replace, or a change to `identifier`;
   - `snapshot_identifier` other than `$PRE`, or `skip_final_snapshot` other than `false`;
   - an image with the cutover tag, or `identity_v8_backfill_on_deploy` true (the backfill must not run on the restored database).

   Then apply the saved plan (the replace takes minutes; the new instance is created from `$PRE`):

   ```sh
   tofu apply restore.tfplan
   ```

   If the apply fails part-way, stop. Do not re-run it blind: read the state (`tofu state show module.stack.module.rds.aws_db_instance.this`) and the console first.

5. **C4. The services back on v7, through the apply's revisions.** Read the revision numbers the apply registered for `api` and `worker` (the v7 image), and check their image:

   ```sh
   aws ecs describe-task-definition --task-definition rova-prod-api:<rev> --query 'taskDefinition.containerDefinitions[0].image' --output text   # ends with :$TAG_PRE
   aws ecs update-service --cluster rova-prod --service api    --task-definition rova-prod-api:<rev>    --force-new-deployment
   aws ecs update-service --cluster rova-prod --service worker --task-definition rova-prod-worker:<rev> --force-new-deployment
   aws ecs wait services-stable --cluster rova-prod --services api worker
   ```

   Never use the previous revisions: they point at the endpoint that no longer exists. **Never redeploy the cutover tag.** Its migrator would run 0131 to 0136 and the backfill again, on the restored database.

6. **C5. The previous SPA.** Cloudflare Pages: Workers & Pages -> `rova-prod-web` -> Deployments -> the deployment before the cutover -> **Rollback to this
   deployment**. Do the SPA and the API together: a v8 SPA against a v7 API cannot sign anyone in.

7. **C6. Deletion protection back on, own apply.** On the branch: `deletion_protection = true`, and remove `snapshot_identifier` and `skip_final_snapshot`.
   `tofu plan` must show no replace, only the in-place `~ deletion_protection` (the module ignores `snapshot_identifier` after the create).

8. **Verify.** Staff can sign in on v7 and see the data as of `$PRE`'s time. Keep the forensic snapshot and `$PRE` until the owner says otherwise; this runbook does not delete them.

## Stale release tag (prod-state.env)

The script saves what it has found in `~/.local/state/rova-identity-v8/prod-state.env`: `PRE_SNAPSHOT` (the restore point), `TAG_BEFORE` (the newest release tag
before the release-please PR), `RELEASE_PAUSED` and `RELEASE_TAG`. If `RELEASE_TAG` is wrong (a tag that is not this release, or one the script refuses as not
reachable from origin/main), delete **only the `RELEASE_TAG` line**, then run `--from release`. `RELEASE_PAUSED` stays: the release-please pause is already past, so the
script detects the new tag against `TAG_BEFORE` and asks you to confirm it. Keep `PRE_SNAPSHOT` and `TAG_BEFORE`: the restore point must not change for the same release.

## Day 7 and day 30 (separate changes, not #718; tracked as rova issues; not prerequisites for the production cutover)

- **Day 7, freeze:** stop writing v7, remove `JWT_PRIVATE_KEY`, `JWT_*` and `ENTRA_REDIRECT_URI` from the task definitions, remove the v7 redirect URI from the
  Entra app. **The worker's daily cleanup (`apps/worker/src/cron/cleanup.cron.ts`, `DELETE FROM identity.auth_sessions ...`) is a v7 write**: it must go in the
  same change, or the freeze (which revokes `INSERT/UPDATE/DELETE` on the v7 identity tables from the app roles) turns it into a failing job every day. The seed's v7 SSO
  connection writes (`db/seeds/bootstrap.ts`) stop at the same time; the sign-in hook already reads the home workspace from `HOME_WORKSPACE_ID` and the domains and
  the JIT flag from the environment, not from `sso_connections`.
- **Day 30, drop:** `DROP` the v7 tables (`auth_sessions`, `sso_identities`, `sso_connections`, `sso_connection_domains`) in a migration.
- **Done (#728, identity 8.4.1, app-platform#261):** the PostgreSQL 18 `postgres-conformance` service and `IDENTITY_CONFORMANCE_DATABASE_URL` are gone from
  `backend-ci.yml` (the kit then runs on the e2e PostgreSQL 17).

## Not in this change (PR 4)

`User.Invite.All` (the Graph application permission the worker uses to invite a vendor as a B2B guest) is still on the **sign-in** app, and the worker still
authenticates to Graph with `ENTRA_CLIENT_SECRET`. The plan moves it to the "Rova <Env> Service" app with a certificate (worker only), which is rova#715 (the code)
and rova#716 (the infra: the standalone secret `rova/<env>/mail-graph-certificate`). It is a separate change on purpose: it is a different app registration, a different
credential and a different consent, and it must not ride on a sign-in cutover. When it lands the sign-in app is delegated-only.

## Operating notes

- Rotating `BETTER_AUTH_SECRET` signs everyone out (and nothing else). `COOKIE_SECRET` and `CSRF_SECRET` are separate and unaffected.
- A session lasts 12 hours (the `staff` preset); there is no refresh. Signing in again is one redirect.
- Offboarding someone from the workspace is unchanged (members -> suspend/remove). To disable a person everywhere, ban their identity user (`setUserBanned`, service side): it
  ends every session and refuses sign-in and API tokens at once. There is no admin screen for it yet.
- Rate limits: an address-keyed floor runs first (1,200 requests/min per address, 300/min of API-token presentations per address), the user-keyed `DEFAULT` after authentication.
- The identity package's own checks run in CI as `test/e2e/identity-conformance.e2e.spec.ts` (against the PostgreSQL 17 e2e server: identity 8.4.1's kit uses `gen_random_uuid()`).

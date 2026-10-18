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

**Interactive script:** `scripts/owner/identity-v8-cutover.sh` (in #729) runs the develop steps with `develop` and the production steps with `prod` (see "Production"). The develop run covers steps 1 to 6 and the rehearsal (below), one step at a time, with a `yes` before each write. It discovers the names, checks the migrator image contains #719, writes the key (never printed), runs the dry run and the commit, checks the invariant, pauses for the #718 merge, re-runs the backfill, walks the verification checklist and the rollback rehearsal. `--from <step>` resumes (`preflight`, `secret`, `backfill-dry`, `commit`, `merge`, `verify`, `rehearsal`). Its log holds no secret values. Production is the `prod` run, with its own snapshot and release steps.

**The script lands with #729, after #718.** Until #729 merges, run its steps from the #729 branch, in a worktree next to this checkout: `git worktree add ../wt729 owner/identity-v8-develop-cutover`, then `bash ../wt729/scripts/owner/identity-v8-cutover.sh develop`. The pre-merge steps (secret, dry run, commit) need nothing from #718's merge.

Steps 1-3 are additive and happen **before** #718 deploys; 4-6 are the window. Production runs the same steps in one release, shortly after develop is verified, with an announced downtime and a database snapshot before any write (see "Production").

1. **Dry run of the backfill**, from the migrator image (it has the SQL since #719). A one-off ECS task on the migrator's task definition, with the
   command overridden. **First verify what that task definition runs**: its image must be a build of `main` that contains #719 (merge commit `4744d1b3`), or the
   command fails with `Cannot find module` / `ENOENT backfill.sql`:

   ```sh
   aws ecs describe-task-definition --task-definition "$TASKDEF" --query 'taskDefinition.containerDefinitions[?name==`migrator`].image' --output text
   # -> .../rova-migrator:<tag>. On develop the tag is the commit it was built from: `git merge-base --is-ancestor 4744d1b3 <that commit>` must succeed.
   ```

Names below are `rova-<env_slug>`. They come from `infra/modules/stack` (`name = "${product}-${env_slug}"`: cluster `rova-develop`, services `rova-develop-api` and `rova-develop-worker`, migrator family `rova-develop-migrator`, API log group `/ecs/rova-develop-api`). The owner script confirms them against the account before any write.

```sh
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1 ENV_SLUG=develop        # production: prod
CLUSTER=rova-$ENV_SLUG TASKDEF=rova-$ENV_SLUG-migrator

# discovery: the cluster, its services, and the network the API runs in (the migrator task needs the same subnets and a security group
# that can reach the database, i.e. the API's)
aws ecs list-clusters --query 'clusterArns' --output text
aws ecs list-services --cluster "$CLUSTER" --output text
aws ecs describe-services --cluster "$CLUSTER" --services "$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[?contains(@, `-api`)]|[0]' --output text)" \
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

4. **Deploy** (#718): the API, the worker and the web. On develop that is the merge; on production it is the tag (the guard above lets it through once `better_auth_secret_set = true`).
   The API starts only if `BETTER_AUTH_SECRET` is present: a missing secret is a task that cannot start, not a silent downgrade, and the previous task keeps serving
   until the new one is healthy.

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

Prod's migrator image only comes from a release tag, so the dry run uses an explicit digest of a build of `main`, and the cutover tag's own migrator commits the backfill. `bash scripts/owner/identity-v8-cutover.sh prod` does both, in this order:

### (a) The dry run: from an explicit image digest (the script's `adhoc-dry` step)

The ECR repositories are one account and one set of repositories for every environment, and a `main` build is `rova-migrator:sha-<full commit sha>`. A
build of `main` that contains #719 (merge commit `4744d1b3`) therefore already holds the backfill. A one-off task names its **digest**, not a tag, so what
runs is exactly what you inspected. A task definition's image cannot be overridden at `run-task`, so register an **ad-hoc** definition (its own family: the
Terraform-managed `rova-prod-migrator` is never touched):

```sh
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
SHA=<a commit on main that contains 4744d1b3; e.g. the newest>      # git merge-base --is-ancestor 4744d1b3 $SHA
REPO=rova-migrator

# 1. the digest of that build, and proof it is the build of that commit (the tag is immutable)
DIGEST=$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="sha-$SHA" --query 'imageDetails[0].imageDigest' --output text)
REGISTRY=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com
echo "$REGISTRY/$REPO@$DIGEST"
# provenance, the same check the deploy runs on the API image (signed by the shared builder workflow, scoped to this repository):
gh attestation verify "oci://$REGISTRY/$REPO@$DIGEST" --repo quynhonsemiconductor/rova \
  --signer-workflow quynhonsemiconductor/ci/.github/workflows/backend-deploy.yml

# 2. an ad-hoc task definition: prod's migrator definition with ONLY the image changed, under another family
aws ecs describe-task-definition --task-definition rova-prod-migrator --query taskDefinition > /tmp/migrator.json
jq --arg image "$REGISTRY/$REPO@$DIGEST" \
  'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
   | .family = "rova-prod-migrator-adhoc"
   | (.containerDefinitions[] | select(.name == "migrator").image) = $image' /tmp/migrator.json > /tmp/migrator-adhoc.json
aws ecs register-task-definition --cli-input-json file:///tmp/migrator-adhoc.json --query 'taskDefinition.taskDefinitionArn' --output text

# 3. verify the SQL is in it, then dry-run (the same run_migrator helper as above, with the ad-hoc family)
export ENV_SLUG=prod CLUSTER=rova-prod TASKDEF=rova-prod-migrator-adhoc
TASK=$(run_migrator '["ls","dist/db/identity-v8"]')     # expect: backfill.sql cli.js ... mirror-bans.sql rollback.sql run.js
TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","backfill","--tenant-id","'"$TENANT_ID"'","--staff-domains","qnsc.vn"]')
```

Read each task's exit code and log as in step 1. **Commit nothing from here:** a dry run rolls back, and on production the commit is (b)'s job. Deregister the
ad-hoc revision when you are done (`aws ecs deregister-task-definition`). A `RAISE` on production data is the point of doing this a week early: fix it in v7,
dry-run again, until it passes.

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

1. **Backup:** assert automated backups (retention at least 7 days), create the manual snapshot `rova-prod-pre-identity-v8-<date>`, and wait until it is available. Nothing is written before this.
2. **Secret and Entra:** `better-auth-secret` into `rova/production/app`; the redirect URI and the optional claims `email` and `upn` on the production sign-in app.
   2b. **Edge secret** (`docs/runbooks/edge-client-ip.md`): one generated value, set as the Pages secret `EDGE_CLIENT_IP_SECRET` on `rova-prod-web` and as `edge-client-ip-secret` in `rova/production/app`. The script refuses if either already exists, because the Pages value cannot be read back. It must exist before the release: the Function answers 500 without it.
3. **Dry run** from the digest of a build of `main` (provenance verified), through an ad-hoc task definition. Writes nothing.
4. **Release change:** `better_auth_secret_set`, `edge_client_ip_secret_set` and `identity_v8_backfill_on_deploy` all `true` in `infra/live/prod/main.tf`, merged, and `infra-apply` applied.
5. **Announce** the downtime, then cut the tag (the script asks for the name and confirms before it pushes). Backend deploy: migrate, **backfill commit**, API roll; the web deploy waits for it.
6. **Verify** (you and one other person). Then the follow-up change sets `identity_v8_backfill_on_deploy` back to `false`.

Rollback in this window is in "Rollback" below. The snapshot is the last resort.

### The web deploy of a prod tag can time out waiting for the backend

`wait-for-backend` allows 6 hours: the backend deploy itself waits for apply-prod and the `production` environment's required reviewer. If it still expires, the
web job fails and the SPA is **not** published (the safe direction: the previous SPA keeps serving against the new API for a while). **Re-run the web jobs once the
backend deploy is green** (Actions -> Web - Deploy -> the tag's run -> Re-run all jobs). Never publish the SPA by hand ahead of the API.

## Rollback

Until the v7 tables are dropped (the day-30 change), nothing in the database has to be undone **except the bans** (step 1). Two paths; pick by urgency.

**Before either: mirror the bans** (v8-only bans would otherwise be silently lifted, because the v7 image reads `identity.users.status`, not identity 8's `banned`):

```sh
TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","mirror-bans"]')                                   # dry run: prints the counts
TASK=$(run_migrator '["node","dist/db/identity-v8/cli.js","mirror-bans","--commit","--database","<database name>"]')
```

**A. Fast (minutes): put the previous task definitions back, and the previous SPA.** For the API and the worker (replace `<prev>` with the revision that was live before the cutover; read it from `aws ecs list-task-definitions --family-prefix rova-$ENV_SLUG-api --sort DESC`):

```sh
aws ecs update-service --cluster "$CLUSTER" --service rova-$ENV_SLUG-api    --task-definition rova-$ENV_SLUG-api:<prev>    --force-new-deployment
aws ecs update-service --cluster "$CLUSTER" --service rova-$ENV_SLUG-worker --task-definition rova-$ENV_SLUG-worker:<prev> --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services rova-$ENV_SLUG-api rova-$ENV_SLUG-worker
```

then Cloudflare Pages: Workers & Pages -> `rova-<env>-web` -> Deployments -> the deployment before the cutover -> **Rollback to this deployment**. Do the SPA
and the API together: a v8 SPA against a v7 API (or the reverse) cannot sign anyone in. This path leaves Terraform's desired state ahead of the running
state; the **next** deploy re-registers the current definition, so follow it with path B the same day. The previous task definitions need
`JWT_PRIVATE_KEY` and `ENTRA_REDIRECT_URI`: they are still bound on purpose.

**B. Durable (an hour): revert the merge.** `git revert -m 1 <the #718 merge commit>` in a PR titled `revert: identity 8 cutover`, merge it; develop deploys
on merge and production on the next tag (the revert also removes the tag guard, since the guard belongs to #718). Keep `better_auth_secret_set` as is.

In both: people sign in again (v8 sessions mean nothing to v7, and the reverse) and are provisioned by v7's sign-in as before; anyone created in v8 has a profile row
that v7's sign-in links by address; the `rly_` tokens, workspace membership and roles are shared and untouched.

Do **not** run `db:identity-v8:rollback` as part of this rollback: the v8 tables are inert for the v7 image and hold the bans. It exists to undo migration 0136
on a database where nothing has been written, and it refuses once a later migration is recorded (roll forward with a DROP migration).

A fix-forward is usually better than a rollback for a problem in the product hook (`StaffSignInHandler`): its refusals are visible, per person, and carry a code.

### Rehearsal (on develop; the script runs it; write the result here)

The rollback has **not been rehearsed** by the author of #718: it needs the ECS and Cloudflare permissions of an operator and a develop deploy to roll back from.
Before the production release, on develop, with the cutover live and at least one ban placed through `setUserBanned`:

1. note the current task definition revisions and Pages deployment id (the "after" state);
2. run `mirror-bans` (dry run, then `--commit`), then path A; confirm: staff sign in on v7, the banned person is refused, an API token still works;
3. roll forward again (path A back to the "after" revisions, or redeploy `main`), re-run the backfill, confirm the banned person is still banned in v8.

| Date | Who | Path | Time to restore service | Surprises | Result |
| ---- | --- | ---- | ----------------------- | --------- | ------ |
|      |     |      |                         |           |        |

## Day 7 and day 30 (separate changes, not #718; tracked as rova issues; not prerequisites for the production cutover)

- **Day 7, freeze:** stop writing v7, remove `JWT_PRIVATE_KEY`, `JWT_*` and `ENTRA_REDIRECT_URI` from the task definitions, remove the v7 redirect URI from the
  Entra app. **The worker's daily cleanup (`apps/worker/src/cron/cleanup.cron.ts`, `DELETE FROM identity.auth_sessions ...`) is a v7 write**: it must go in the
  same change, or the freeze (which revokes `INSERT/UPDATE/DELETE` on the v7 identity tables from the app roles) turns it into a failing job every day. The seed's v7 SSO
  connection writes (`db/seeds/bootstrap.ts`) stop at the same time; the sign-in hook already reads the home workspace from `HOME_WORKSPACE_ID` and the domains and
  the JIT flag from the environment, not from `sso_connections`.
- **Day 30, drop:** `DROP` the v7 tables (`auth_sessions`, `sso_identities`, `sso_connections`, `sso_connection_domains`) in a migration.
- **Whenever identity ships the release with app-platform#261:** delete the PostgreSQL 18 `postgres-conformance` service and `IDENTITY_CONFORMANCE_DATABASE_URL` from
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
- The identity package's own checks run in CI as `test/e2e/identity-conformance.e2e.spec.ts` (against a PostgreSQL 18 service until the kit runs on 17).

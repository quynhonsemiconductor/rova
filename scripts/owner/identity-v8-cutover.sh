#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted strings below are JavaScript for the invariant check, not shell expansions
#
# Owner checklist: the identity v8 cutover on DEVELOP (docs/runbooks/identity-v8-cutover.md). Interactive, one step at a time.
# Every write waits for you to type `yes`. No secret value is printed. Production is NOT handled here (its own window).
#
#   bash scripts/owner/identity-v8-develop-cutover.sh                 # from the top
#   bash scripts/owner/identity-v8-develop-cutover.sh --from commit   # resume at a step (STEPS below)
#
# Needs: aws CLI v2 (profile qnsc-admin, MFA), jq, python3, git, and this checkout of rova (for the migrator image check).
set -euo pipefail

export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1 AWS_DEFAULT_REGION=ap-southeast-1
PRODUCT=rova
ENV_SLUG=develop
SECRET_ID="$PRODUCT/$ENV_SLUG/app"
EXPECTED_ACCOUNT=608983206583
REDIRECT_URI="https://rova-dev.qnsc.vn/api/auth/callback/microsoft"
MIGRATOR_MIN_COMMIT=4744d1b3   # #719: the migrator image must contain the backfill SQL
STEPS=(preflight secret backfill-dry commit merge verify rehearsal)
ROVA_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/rova-identity-v8"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOG_DIR/develop-cutover-$RUN_ID.log"
STATE="$LOG_DIR/develop-state.env"   # ARNs and ids only, kept across runs so a resumed rehearsal knows the "after" state

# The invariant, run inside the migrator image with the pool config cli.js uses (sslmode included). Prints counts only.
read -r -d '' INVARIANT_JS <<'EOF' || true
const {Client}=require('pg');const {resolveMigrationPoolConfig}=require('./dist/db/pg-pool-config.js');
(async()=>{const c=new Client(resolveMigrationPoolConfig());await c.connect();
const a=await c.query(`SELECT count(*)::int n FROM identity.users WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM identity."user")`);
const b=await c.query(`SELECT count(*)::int n FROM identity."user" u WHERE u.id NOT IN (SELECT id FROM identity.users WHERE deleted_at IS NULL) AND NOT (u.banned AND u.id IN (SELECT id FROM identity.users WHERE deleted_at IS NOT NULL))`);
console.log("INVARIANT profile_without_login="+a.rows[0].n+" login_without_profile="+b.rows[0].n);await c.end();
})().catch(e=>{console.error("INVARIANT ERROR "+(e.code||e.name));process.exit(1)});
EOF

FROM=preflight
if [ "${1:-}" = "--from" ]; then
  FROM="${2:?--from needs a step name: ${STEPS[*]}}"
  [[ " ${STEPS[*]} " == *" $FROM "* ]] || { echo "unknown step $FROM (steps: ${STEPS[*]})" >&2; exit 2; }
fi

say()  { printf '\n== %s\n' "$*" | tee -a "$LOG" >&2; }
note() { printf '   %s\n' "$*" | tee -a "$LOG" >&2; }
die()  { printf '\nSTOP: %s\n' "$*" | tee -a "$LOG" >&2; exit 1; }
ask()  { read -r -p "$1 " ANSWER; }
confirm() { # confirm "<what will happen>": anything but `yes` stops the script
  local reply
  read -r -p "$1 Type yes to continue: " reply
  [ "$reply" = yes ] || die "stopped before: $1"
}
pause() { read -r -p "$1 Press Enter when done (Ctrl-C stops): " _; }

state_set() { # state_set KEY VALUE
  touch "$STATE" && chmod 600 "$STATE"
  { grep -v "^$1=" "$STATE" || true; printf '%s=%s\n' "$1" "$2"; } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
state_get() { grep "^$1=" "$STATE" 2>/dev/null | cut -d= -f2- || true; }

mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
note "log: $LOG"

# ── checks ───────────────────────────────────────────────────────────────────────────────────────────────────────────
for tool in aws jq python3 git; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
aws --version 2>&1 | grep -q '^aws-cli/2' || die "needs AWS CLI v2 (aws --version)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || die "profile qnsc-admin is account $ACCOUNT, expected $EXPECTED_ACCOUNT"
note "account $ACCOUNT, region $AWS_REGION, profile $AWS_PROFILE"

STARTED=no
run_from() { # run_from <step>: true from the --from step on
  if [ "$1" = "$FROM" ]; then STARTED=yes; fi
  [ "$STARTED" = yes ]
}

# ── discovery: read-only, always runs (a resumed run needs the names too) ──────────────────────────────────────────────
discover() {
  CLUSTER="$(aws ecs list-clusters --query 'clusterArns[]' --output text | tr '\t' '\n' | awk -F/ '$NF == "rova-develop" {print $NF}')"
  [ -n "$CLUSTER" ] || die "no cluster named rova-develop; list them: aws ecs list-clusters"

  local services
  services="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[]' --output text | tr '\t' '\n' | awk -F/ '{print $NF}')"
  API_SERVICE="$(echo "$services" | awk '/-api$/' | head -1)"
  WORKER_SERVICE="$(echo "$services" | awk '/-worker$/' | head -1)"
  [ -n "$API_SERVICE" ] && [ -n "$WORKER_SERVICE" ] || die "api or worker service not found among: ${services//$'\n'/ }"

  local api_json
  api_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --output json)"
  API_TASKDEF_ARN="$(echo "$api_json" | jq -r '.services[0].taskDefinition')"
  NET="$(echo "$api_json" | jq -c '{awsvpcConfiguration: {subnets: .services[0].networkConfiguration.awsvpcConfiguration.subnets,
          securityGroups: .services[0].networkConfiguration.awsvpcConfiguration.securityGroups,
          assignPublicIp: .services[0].networkConfiguration.awsvpcConfiguration.assignPublicIp}}')"

  local mig_json mig='.taskDefinition.containerDefinitions[] | select(.name=="migrator")'
  mig_json="$(aws ecs describe-task-definition --task-definition "$CLUSTER-migrator" --output json)" || die "no task definition family $CLUSTER-migrator"
  MIG_REV_ARN="$(echo "$mig_json" | jq -r '.taskDefinition.taskDefinitionArn')"   # the verified revision: every run-task uses this one
  MIG_IMAGE="$(echo "$mig_json" | jq -r "$mig.image")"
  MIG_LOG_GROUP="$(echo "$mig_json" | jq -r "$mig.logConfiguration.options[\"awslogs-group\"]")"
  MIG_LOG_PREFIX="$(echo "$mig_json" | jq -r "$mig.logConfiguration.options[\"awslogs-stream-prefix\"]")"
  DATABASE_NAME="$(echo "$mig_json" | jq -r "$mig.environment[]? | select(.name==\"DATABASE_NAME\") | .value")"
  TENANT_ID="$(echo "$mig_json" | jq -r "$mig.environment[]? | select(.name==\"ENTRA_TENANT_ID\") | .value")"
  if [ -z "$DATABASE_NAME" ]; then ask "DATABASE_NAME is not in the task environment; type the database name:"; DATABASE_NAME="$ANSWER"; fi
  if [ -z "$TENANT_ID" ]; then ask "ENTRA_TENANT_ID is not in the task environment; type the sign-in app's tenant id:"; TENANT_ID="$ANSWER"; fi
}

print_discovery() {
  say "a. preflight: the names in the account (read-only)"
  note "cluster $CLUSTER; services $API_SERVICE, $WORKER_SERVICE"
  note "api task definition (live): $API_TASKDEF_ARN"
  note "migrator task definition (the revision every run uses): $MIG_REV_ARN"
  note "migrator image: $MIG_IMAGE"
  note "migrator log group $MIG_LOG_GROUP, stream prefix $MIG_LOG_PREFIX; database $DATABASE_NAME; tenant $TENANT_ID"
  note "one-off network (the API's subnets and security groups): $NET"
  local tag="${MIG_IMAGE##*:}" sha
  sha="${tag#sha-}"
  if [[ "$tag" == sha-* ]] && git -C "$ROVA_REPO" cat-file -e "$sha" 2>/dev/null &&
     git -C "$ROVA_REPO" merge-base --is-ancestor "$MIGRATOR_MIN_COMMIT" "$sha"; then
    note "migrator image contains #719 ($MIGRATOR_MIN_COMMIT): ok"
  else
    die "the migrator image ($tag) does not contain $MIGRATOR_MIN_COMMIT (#719), or this checkout lacks that commit: git -C $ROVA_REPO fetch origin main"
  fi
  confirm "Are these the names you expect (rova-develop-api / -worker / -migrator)?"
}

# ── AWS helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
run_migrator() { # run_migrator <JSON array: the command>  -> prints the task ARN
  local overrides out arn
  overrides="$(jq -cn --argjson c "$1" '{containerOverrides: [{name: "migrator", command: $c}]}')"
  out="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIG_REV_ARN" --launch-type FARGATE \
    --network-configuration "$NET" --overrides "$overrides" --output json)"
  arn="$(echo "$out" | jq -r '.tasks[0].taskArn // empty')"
  [ -n "$arn" ] || { echo "$out" | jq -c '.failures' >&2; die "run-task did not start a task"; }
  echo "$arn"
}

wait_task() { # wait_task <task ARN>  -> sets TASK_CODE (the migrator's exit code) and TASK_LOG (its log file); no subshell, so both survive
  local arn="$1" id code reason
  id="${arn##*/}"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$arn" >/dev/null 2>&1 ||
    die "task $id is still running or the wait failed: do not re-run this step until it stops (aws ecs describe-tasks --cluster $CLUSTER --tasks $arn)"
  code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --query 'tasks[0].containers[?name==`migrator`].exitCode | [0]' --output text)"
  reason="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --query 'tasks[0].stoppedReason' --output text)"
  TASK_LOG="$LOG_DIR/task-$id.log"
  aws logs filter-log-events --log-group-name "$MIG_LOG_GROUP" --log-stream-names "$MIG_LOG_PREFIX/migrator/$id" --output json |
    jq -r '.events[].message' > "$TASK_LOG" || note "(could not read the task log; check $MIG_LOG_GROUP)"
  note "task $id: exit $code; stopped: $reason"
  note "its log (last 80 lines; full copy in $TASK_LOG):"
  tail -80 "$TASK_LOG" | tee -a "$LOG" >&2
  TASK_CODE="$code"
}

service_primary_completed() { # <service>: the PRIMARY deployment has rolled out
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" --output json |
    jq -e '.services[0].deployments[] | select(.status == "PRIMARY" and .rolloutState == "COMPLETED")' >/dev/null
}
service_on() { # service_on <service> <task definition ARN>: exit status
  [ "$(aws ecs describe-services --cluster "$CLUSTER" --services "$1" --query 'services[0].taskDefinition' --output text)" = "$2" ]
}
api_live_has_secret() { # the live API task definition injects BETTER_AUTH_SECRET
  local arn
  arn="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --query 'services[0].taskDefinition' --output text)"
  aws ecs describe-task-definition --task-definition "$arn" --query 'taskDefinition.containerDefinitions[].secrets[].name' --output json |
    jq -e 'index("BETTER_AUTH_SECRET") != null' >/dev/null
}
check_invariant() {
  say "invariant check: both counts must be 0 (one-off task; prints counts only)"
  local arn code
  arn="$(run_migrator "$(jq -Rs '["node","-e",.]' <<< "$INVARIANT_JS")")"
  wait_task "$arn"; code="$TASK_CODE"
  [ "$code" = 0 ] || die "invariant check failed or could not run (exit $code): read $TASK_LOG"
  grep -qx 'INVARIANT profile_without_login=0 login_without_profile=0' "$TASK_LOG" ||
    die "invariant is NOT zero: read the INVARIANT line in $TASK_LOG"
  note "PASS: invariant holds (both 0)"
}

# ── the bundle: values are read into memory and never printed ─────────────────────────────────────────────────────────
read_secret() {
  SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text)" ||
    die "cannot read $SECRET_ID (MFA expired? access?)"
  printf '%s' "$SECRET_JSON" | jq -e 'type == "object"' >/dev/null || die "$SECRET_ID is not a JSON object"
}
key_present() { printf '%s' "$SECRET_JSON" | jq -e 'has("better-auth-secret")' >/dev/null; }
key_ok() {
  printf '%s' "$SECRET_JSON" | jq -e '(.["better-auth-secret"] | type == "string") and ((.["better-auth-secret"] | length) >= 32)' >/dev/null
}

# ── steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
step_secret() {
  say "b. the better-auth-secret key in $SECRET_ID (values never printed)"
  read_secret
  printf '%s' "$SECRET_JSON" | jq -e 'has("cookie-secret") and has("csrf-secret")' >/dev/null ||
    die "the bundle lacks cookie-secret or csrf-secret: check the bundle before anything is written"
  if key_present; then
    key_ok || die "better-auth-secret is present but short or not a string: fix it by hand (rotating signs everyone out)"
    note "present and at least 32 characters: nothing written"
  else
    confirm "Write a NEW better-auth-secret into $SECRET_ID (read-modify-write; the other keys are kept)?"
    local new_json before after
    new_json="$(printf '%s' "$SECRET_JSON" | python3 -c '
import json, secrets, sys
d = json.load(sys.stdin)
if "better-auth-secret" in d:
    sys.exit("the key appeared since the check")
d["better-auth-secret"] = secrets.token_urlsafe(48)
json.dump(d, sys.stdout)
')" || die "could not build the new bundle (nothing written)"
    before="$(printf '%s' "$SECRET_JSON" | jq -c '[keys[]] | sort')"
    after="$(printf '%s' "$new_json" | jq -c '[keys[]] | sort')"
    [ "$after" = "$(printf '%s' "$before" | jq -c '. + ["better-auth-secret"] | sort')" ] ||
      die "the key set would change by more than the one key (nothing written)"
    printf '%s' "$new_json" | aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string file:///dev/stdin >/dev/null ||
      die "the write failed (nothing was changed)"
    unset new_json
    read_secret
    key_ok || die "after the write the key is missing or short. Restore the previous version: aws secretsmanager update-secret-version-stage --secret-id $SECRET_ID --version-stage AWSCURRENT --move-to-version-id <previous version id> --remove-from-version-id <current version id>"
    note "written; the key count and length checked, the value not shown"
  fi
  unset SECRET_JSON

  say "b. Entra, on the sign-in app \"Rova Dev\" (manual, Entra admin centre)"
  note "Authentication -> Web -> add the redirect URI: $REDIRECT_URI"
  note "KEEP the v7 one (/v1/bff/callback). It goes away on day 7, not now."
  note "Token configuration -> optional claims, ID token: add email AND upn. Without them staff sign-in is refused after the cutover."
  pause "Do both now."
}

step_backfill_dry() {
  say "c. backfill DRY RUN through a one-off migrator task"
  note "a dry run writes nothing. If it raises, the log names the ids and counts that are wrong."
  confirm "Run the backfill dry run on $CLUSTER?"
  local arn code
  arn="$(run_migrator "[\"node\",\"dist/db/identity-v8/cli.js\",\"backfill\",\"--tenant-id\",\"$TENANT_ID\",\"--staff-domains\",\"qnsc.vn\"]")"
  wait_task "$arn"; code="$TASK_CODE"
  if [ "$code" = 0 ]; then
    note "PASS: exit 0"
    return 0
  fi
  cat <<'EOF' | tee -a "$LOG" >&2

   The dry run RAISED. Each raise is a data decision, not a retry. Read the RAISE lines above and fix the cause in v7:
   - an off-domain user (e.g. admin@qnsc.dev, the develop seed's admin): give them an address on qnsc.vn, or soft-delete
     them in v7 (identity.users.deleted_at) if they are fixture data. The seed is rova code (db/seeds/), so keeping the
     fixture from coming back is a rova PR, not a database edit.
   - more than one Entra identity for one person, or two users sharing a lower-cased address: merge or delete one in v7.
   - an sso_connections row beyond the home connection and the shared guest gate: remove it in v7.
   Then run:  bash scripts/owner/identity-v8-develop-cutover.sh --from backfill-dry
EOF
  die "dry run failed (exit $code)"
}

step_commit() {
  say "d. COMMIT the backfill (additive: reads v7, writes identity.user and identity.account)"
  confirm "Commit the backfill to database $DATABASE_NAME?"
  local arn code
  arn="$(run_migrator "[\"node\",\"dist/db/identity-v8/cli.js\",\"backfill\",\"--tenant-id\",\"$TENANT_ID\",\"--staff-domains\",\"qnsc.vn\",\"--commit\",\"--database\",\"$DATABASE_NAME\"]")"
  wait_task "$arn"; code="$TASK_CODE"
  [ "$code" = 0 ] || die "commit failed (exit $code). The backfill is idempotent: fix the cause and re-run this step"
  check_invariant
}

step_merge() {
  say "e. before the merge: the checks that must already hold"
  read_secret
  key_ok || die "better-auth-secret is missing or short in $SECRET_ID"
  unset SECRET_JSON
  check_invariant
  say "e. PAUSE: the SA merges #718 on your go (this script does not merge)"
  note "After the merge, develop deploys the API, the worker and the web. Wait for the deploy to finish."
  pause "Tell the SA: merge #718. Press Enter here once the develop deploy has finished."
  api_live_has_secret || die "the live API task definition does not inject BETTER_AUTH_SECRET: the deploy has not landed (or it is not #718's)"
  service_primary_completed "$API_SERVICE" || die "the API's primary deployment is not COMPLETED yet: wait, then run this step again with --from merge"
  note "PASS: the live API injects BETTER_AUTH_SECRET and its deployment is COMPLETED"
}

step_verify() {
  say "f. re-run the backfill after the deploy (idempotent), then the verification checklist"
  step_commit
  local items=(
    "Staff sign-in lands in the home workspace; GET /v1/auth/me returns the same id as before the cutover."
    "A workspace switch works for a member of two workspaces; it is 403 for a workspace they are not in, and for a deleted one."
    "Removing a member drops the workspace on their open session within a second."
    "A vendor with a live invitation signs in as a guest and sees only what the invitation granted; a guest with none gets ?error=STAFF_SIGN_IN_REFUSED."
    "An API token minted before the cutover authenticates; after revoke it is 401; banning the owner (setUserBanned) makes their token 401."
    "A user suspended or removed from the workspace has zero permissions, and their API tokens are revoked."
    "301 requests with made-up rly_ tokens from one address end in 429."
    "Sign out and sign-out-everywhere end the session; GET /api/auth/get-session has no \"token\"."
    "No identity.profile_id_mismatch, identity.auth_handler_threw or identity.context_cache_stale log line (search below)."
  )
  local i=0 item
  for item in "${items[@]}"; do
    i=$((i + 1))
    ask "Checklist $i passed? (yes/no) -- $item"
    [ "$ANSWER" = yes ] || die "checklist item $i did not pass: fix it, record the time and request id, then run this step again with --from verify"
  done
  note "all ${#items[@]} verification items passed"
  local since=$(( ($(date +%s) - 3600) * 1000 )) pattern
  note "log search, last hour (run as is):"
  for pattern in identity.profile_id_mismatch identity.auth_handler_threw identity.context_cache_stale; do
    note "  aws logs filter-log-events --log-group-name /ecs/$CLUSTER-api --filter-pattern '$pattern' --start-time $since --query 'events[].message' --output text"
  done
}

step_rehearsal() {
  say "g. ROLLBACK REHEARSAL on develop (mirror-bans -> path A -> roll forward -> backfill)"
  api_live_has_secret || die "the live API does not inject BETTER_AUTH_SECRET: the rehearsal needs the cutover to be live"
  local after_api after_worker prev_api prev_worker arn code family
  after_api="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --query 'services[0].taskDefinition' --output text)"
  after_worker="$(aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" --query 'services[0].taskDefinition' --output text)"
  state_set AFTER_API "$after_api"
  state_set AFTER_WORKER "$after_worker"
  note "after-cutover revisions (saved in $STATE): api $after_api ; worker $after_worker"
  ask "The Cloudflare Pages deployment id of rova-develop-web NOW (the after-cutover one, Deployments tab):"
  state_set AFTER_PAGES "$ANSWER"

  note "Place a ban through setUserBanned on a DEVELOP test user (never a real person) and write down its id."
  pause "Place the ban now."

  arn="$(run_migrator '["node","dist/db/identity-v8/cli.js","mirror-bans"]')"
  wait_task "$arn"; code="$TASK_CODE"; [ "$code" = 0 ] || die "mirror-bans dry run failed (exit $code)"
  confirm "mirror-bans COMMIT (writes identity.users.status for v8 bans)?"
  arn="$(run_migrator "[\"node\",\"dist/db/identity-v8/cli.js\",\"mirror-bans\",\"--commit\",\"--database\",\"$DATABASE_NAME\"]")"
  wait_task "$arn"; code="$TASK_CODE"; [ "$code" = 0 ] || die "mirror-bans commit failed (exit $code)"

  for family in api worker; do
    note "previous $family revisions (the ones live before the cutover):"
    aws ecs list-task-definitions --family-prefix "$CLUSTER-$family" --sort DESC --max-items 8 --query 'taskDefinitionArns' --output text |
      tr '\t' '\n' | sed 's/^/     /' | tee -a "$LOG" >&2
  done
  ask "Type the PREVIOUS api revision ARN (the one before the cutover):"; prev_api="$ANSWER"
  ask "Type the PREVIOUS worker revision ARN:"; prev_worker="$ANSWER"
  validate_revision "$prev_api" "$CLUSTER-api" "$after_api"
  validate_revision "$prev_worker" "$CLUSTER-worker" "$after_worker"
  state_set PREV_API "$prev_api"
  state_set PREV_WORKER "$prev_worker"

  confirm "PATH A: put the previous api and worker revisions back on develop (--force-new-deployment)?"
  aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" --task-definition "$prev_api" --force-new-deployment >/dev/null
  aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --task-definition "$prev_worker" --force-new-deployment >/dev/null
  wait_services_on "$prev_api" "$prev_worker"
  pause "Now roll the SPA back too: Cloudflare Pages, rova-develop-web -> Deployments -> the one before the cutover -> Rollback to this deployment. Press Enter when done."
  note "Check: staff sign-in on v7 works; the banned test user is refused; an API token still works."
  ask "All three hold? (yes/no)"; [ "$ANSWER" = yes ] || die "a rollback check failed: the state is saved; fix it, then run --from rehearsal"

  confirm "ROLL FORWARD: put the after-cutover revisions back ($after_api, $after_worker)?"
  aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" --task-definition "$after_api" --force-new-deployment >/dev/null
  aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --task-definition "$after_worker" --force-new-deployment >/dev/null
  wait_services_on "$after_api" "$after_worker"
  pause "Roll the Pages deployment forward to AFTER_PAGES ($(state_get AFTER_PAGES)). Press Enter when done."

  confirm "Re-run the backfill (idempotent) and confirm the test user is still banned in v8?"
  step_commit
  pause "Confirm the test user is still banned in v8."
  note "UNBAN the test user to finish: setUserBanned(false) in v8, then check the v7 status and the mirror-bans state, as the runbook says."
  pause "Unban done."
  cat <<EOF | tee -a "$LOG" >&2

  Record the rehearsal in docs/runbooks/identity-v8-cutover.md, the table under "Rehearsal":
  | $(date -u +%F) | <you> | A (mirror-bans, path A, roll forward) | <minutes> | <surprises> | <result> |
  Revisions: after = $after_api / $after_worker ; previous = $prev_api / $prev_worker
  Pages deployments: after = $(state_get AFTER_PAGES) ; previous = <write it down>
  If the secret must be restored, see the message in step b (update-secret-version-stage, AWSPREVIOUS).
EOF
}

validate_revision() { # validate_revision <ARN> <family> <after-cutover ARN it must not be>
  local arn="$1" family="$2" after="$3" got
  got="$(aws ecs describe-task-definition --task-definition "$arn" --query 'taskDefinition.family' --output text)" ||
    die "$arn is not a task definition"
  [ "$got" = "$family" ] || die "$arn is in family $got, not $family"
  [ "$arn" != "$after" ] || die "$arn is the after-cutover revision: the previous one is the one before it"
}
wait_services_on() { # <api ARN> <worker ARN>: the waiter alone also returns after a rollback, so check the revisions too
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$API_SERVICE" "$WORKER_SERVICE" ||
    die "services did not reach stable: check the deployments in the console before anything else"
  service_on "$API_SERVICE" "$1" || die "api is not on $1 (a circuit breaker may have rolled it back)"
  service_on "$WORKER_SERVICE" "$2" || die "worker is not on $2"
  note "PASS: api and worker are on the revisions asked for, and stable"
}

# ── run ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
discover
run_from preflight && print_discovery
run_from secret && step_secret
run_from backfill-dry && step_backfill_dry
run_from commit && step_commit
run_from merge && step_merge
run_from verify && step_verify
run_from rehearsal && step_rehearsal
say "done. The log is at $LOG (it holds no secret values)."

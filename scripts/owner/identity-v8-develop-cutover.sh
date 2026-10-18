#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted strings are JavaScript for the invariant query, not shell expansions
# Owner checklist: the identity v8 cutover on DEVELOP (docs/runbooks/identity-v8-cutover.md). Interactive, one step at a time.
# Every write waits for you to type `yes`. No secret value is printed. Production is NOT handled here (its own window).
#
#   bash scripts/owner/identity-v8-develop-cutover.sh                 # from the top
#   bash scripts/owner/identity-v8-develop-cutover.sh --from backfill # resume at a step (see STEPS below)
#
# Needs: aws (profile qnsc-admin, MFA), jq, python3, git, and this checkout of rova (for the migrator image check).
set -euo pipefail

export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
ENV_SLUG=develop
PRODUCT=rova
SECRET_ID="$PRODUCT/$ENV_SLUG/app"
EXPECTED_ACCOUNT=608983206583
REDIRECT_URI="https://rova-dev.qnsc.vn/api/auth/callback/microsoft"
MIGRATOR_MIN_COMMIT=4744d1b3   # #719: the migrator image must contain the backfill SQL
STEPS=(preflight secret backfill-dry commit merge verify rehearsal)
ROVA_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/rova-identity-v8"
LOG="$LOG_DIR/develop-cutover-$(date -u +%Y%m%dT%H%M%SZ).log"

FROM=preflight
if [ "${1:-}" = "--from" ]; then
  FROM="${2:?--from needs a step name: ${STEPS[*]}}"
  [[ " ${STEPS[*]} " == *" $FROM "* ]] || { echo "unknown step $FROM (steps: ${STEPS[*]})" >&2; exit 2; }
fi

say()  { printf '\n== %s\n' "$*" | tee -a "$LOG" >&2; }
note() { printf '   %s\n' "$*" | tee -a "$LOG" >&2; }
die()  { printf '\nSTOP: %s\n' "$*" | tee -a "$LOG" >&2; exit 1; }
ask()  { # ask "<question>" -> sets ANSWER
  read -r -p "$1 " ANSWER
}
confirm() { # confirm "<what will happen>"  -- anything but `yes` stops the script
  local reply
  read -r -p "$1 Type yes to continue: " reply
  [ "$reply" = yes ] || die "stopped before: $1"
}
pause() { read -r -p "$1 Press Enter when done (Ctrl-C stops): " _; }

mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
note "log: $LOG"

# ── checks ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
for tool in aws jq python3 git; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || die "profile qnsc-admin is account $ACCOUNT, expected $EXPECTED_ACCOUNT"
note "account $ACCOUNT, region $AWS_REGION, profile $AWS_PROFILE"

STARTED=no
run_from() { # run_from <step> : true when this step should run (--from moves the start)
  if [ "$1" = "$FROM" ]; then STARTED=yes; fi
  [ "$STARTED" = yes ]
}

# ── discovery (read-only): names come from the account, not from the runbook's assumptions ───────────────────────────────
discover() {
  say "a. preflight: real names in the account (read-only)"
  CLUSTER="$(aws ecs list-clusters --query 'clusterArns[]' --output text | tr '\t' '\n' | awk -F/ '$NF ~ /^rova-develop$/ {print $NF}')"
  [ -n "$CLUSTER" ] || die "no cluster named rova-develop; list them: aws ecs list-clusters"
  note "cluster: $CLUSTER"

  local services
  services="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[]' --output text | tr '\t' '\n' | awk -F/ '{print $NF}')"
  note "services: ${services//$'\n'/ }"
  API_SERVICE="$(echo "$services" | awk '/-api$/' | head -1)"
  WORKER_SERVICE="$(echo "$services" | awk '/-worker$/' | head -1)"
  [ -n "$API_SERVICE" ] && [ -n "$WORKER_SERVICE" ] || die "api or worker service not found among: $services"

  local api_json
  api_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --output json)"
  API_TASKDEF_ARN="$(echo "$api_json" | jq -r '.services[0].taskDefinition')"
  NET="$(echo "$api_json" | jq -c '{awsvpcConfiguration: {subnets: .services[0].networkConfiguration.awsvpcConfiguration.subnets, securityGroups: .services[0].networkConfiguration.awsvpcConfiguration.securityGroups, assignPublicIp: "DISABLED"}}')"
  note "api service: $API_SERVICE  (task definition $API_TASKDEF_ARN)"
  note "network for the migrator (the API's subnets and security groups): $NET"

  MIGRATOR_FAMILY="$CLUSTER-migrator"
  local mig_json
  mig_json="$(aws ecs describe-task-definition --task-definition "$MIGRATOR_FAMILY" --output json)" || die "no task definition family $MIGRATOR_FAMILY"
  MIG_REV_ARN="$(echo "$mig_json" | jq -r '.taskDefinition.taskDefinitionArn')"
  local mig='.taskDefinition.containerDefinitions[] | select(.name=="migrator")'
  MIG_IMAGE="$(echo "$mig_json" | jq -r "$mig.image")"
  MIG_LOG_GROUP="$(echo "$mig_json" | jq -r "$mig.logConfiguration.options[\"awslogs-group\"]")"
  MIG_LOG_PREFIX="$(echo "$mig_json" | jq -r "$mig.logConfiguration.options[\"awslogs-stream-prefix\"]")"
  DATABASE_NAME="$(echo "$mig_json" | jq -r "$mig.environment[]? | select(.name==\"DATABASE_NAME\") | .value")"
  TENANT_ID="$(echo "$mig_json" | jq -r "$mig.environment[]? | select(.name==\"ENTRA_TENANT_ID\") | .value")"
  note "migrator task definition: $MIG_REV_ARN"
  note "migrator log group: $MIG_LOG_GROUP   stream prefix: $MIG_LOG_PREFIX"
  note "migrator image: $MIG_IMAGE"
  if [ -z "$DATABASE_NAME" ]; then ask "DATABASE_NAME is not in the task environment; type the database name:"; DATABASE_NAME="$ANSWER"; fi
  if [ -z "$TENANT_ID" ]; then ask "ENTRA_TENANT_ID is not in the task environment; type the sign-in app's tenant id:"; TENANT_ID="$ANSWER"; fi
  note "database: $DATABASE_NAME   tenant: $TENANT_ID"

  # The image must contain #719 (db/identity-v8 SQL), or the command dies with ENOENT backfill.sql.
  local tag="${MIG_IMAGE##*:}" sha
  sha="${tag#sha-}"
  if [[ "$tag" == sha-* ]] && git -C "$ROVA_REPO" cat-file -e "$sha" 2>/dev/null &&
     git -C "$ROVA_REPO" merge-base --is-ancestor "$MIGRATOR_MIN_COMMIT" "$sha"; then
    note "migrator image contains #719 ($MIGRATOR_MIN_COMMIT): ok"
  else
    die "the migrator image ($tag) does not contain $MIGRATOR_MIN_COMMIT (#719), or this checkout lacks that commit: git -C $ROVA_REPO fetch origin main"
  fi

}

confirm_names() {
  say "a. preflight: the names above are what the runbook calls rova-develop-api / -worker / -migrator"
  confirm "Continue with these names?"
}

# ── helpers that touch AWS ─────────────────────────────────────────────────────────────────────────────────────────────
has_key() { # prints nothing; exit status says whether the key exists
  aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text | jq -e 'has("better-auth-secret")' >/dev/null
}
key_long_enough() {
  aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text |
    jq -e '(.["better-auth-secret"] | length) >= 32' >/dev/null
}

run_migrator() { # run_migrator <json array of the command>  -> prints the task ARN
  local out
  out="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATOR_FAMILY" --launch-type FARGATE \
    --network-configuration "$NET" \
    --overrides "{\"containerOverrides\":[{\"name\":\"migrator\",\"command\":$1}]}" --output json)"
  local arn
  arn="$(echo "$out" | jq -r '.tasks[0].taskArn // empty')"
  [ -n "$arn" ] || { echo "$out" | jq -c '.failures' >&2; die "run-task did not start a task"; }
  echo "$arn"
}

wait_and_show() { # wait_and_show <task arn>  -> prints the exit code and the last log lines; returns the exit code
  local arn="$1" id code
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$arn" >/dev/null
  id="${arn##*/}"
  code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --query 'tasks[0].containers[?name==`migrator`].exitCode | [0]' --output text)"
  note "task $id exit code: $code"
  note "log (last 80 lines), stream $MIG_LOG_PREFIX/migrator/$id:"
  aws logs get-log-events --log-group-name "$MIG_LOG_GROUP" --log-stream-name "$MIG_LOG_PREFIX/migrator/$id" \
    --query 'events[].message' --output text 2>/dev/null | tail -80 | tee -a "$LOG" >&2 || note "(no log lines yet; check the log group $MIG_LOG_GROUP)"
  echo "$code"
}

# ── steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
step_secret() {
  say "b. the better-auth-secret key in $SECRET_ID (the value is never printed)"
  if has_key && key_long_enough; then
    note "the key is present and at least 32 characters: nothing to do"
  else
    if has_key; then die "the key is present but shorter than 32 characters; fix it by hand (rotating signs everyone out)"; fi
    confirm "Write a NEW better-auth-secret into $SECRET_ID (a read-modify-write; the other keys are kept)?"
    aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text |
      python3 -c '
import json, secrets, sys
d = json.load(sys.stdin)
assert "better-auth-secret" not in d, "the key appeared since the check; stop"
d["better-auth-secret"] = secrets.token_urlsafe(48)
json.dump(d, sys.stdout)
' | aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string file:///dev/stdin >/dev/null
    key_long_enough || die "after the write the key is missing or short: check the secret by hand"
    note "written; length checked, value not shown"
  fi

  say "b. the Entra redirect URI (manual, in the Entra admin centre)"
  note "On the sign-in app \"Rova Dev\": Authentication -> Web -> add the redirect URI:"
  note "    $REDIRECT_URI"
  note "KEEP the v7 one (/v1/bff/callback). It goes away on day 7, not now."
  pause "Add it now."
}

step_backfill_dry() {
  say "c. backfill DRY RUN, through a one-off migrator task"
  note "dry run writes nothing. If it raises, the printed log names the ids and counts that are wrong."
  confirm "Run the backfill dry run as a one-off task on $CLUSTER?"
  local arn code
  arn="$(run_migrator "[\"node\",\"dist/db/identity-v8/cli.js\",\"backfill\",\"--tenant-id\",\"$TENANT_ID\",\"--staff-domains\",\"qnsc.vn\"]")"
  note "task: $arn"
  code="$(wait_and_show "$arn")"
  if [ "$code" = 0 ]; then
    note "PASS: exit 0 (look for: DRY RUN: every preflight check and assertion passed)"
    return 0
  fi
  cat <<'EOF' | tee -a "$LOG"

   The dry run RAISED. Each raise is a data decision, not a retry. Read the RAISE lines above and fix the cause in v7:
   - an off-domain user (e.g. admin@qnsc.dev, the develop seed's admin): either give them an address on qnsc.vn, or
     soft-delete them in v7 (identity.users.deleted_at) if they are fixture data. The seed is rova code (db/seeds/),
     so a change that keeps it from coming back is a rova PR, not a database edit.
   - more than one Entra identity for one person, or two users sharing a lower-cased address: merge or delete one in v7.
   - an sso_connections row beyond the home connection and the shared guest gate: remove it in v7.
   Then run this script again with:  --from backfill-dry
EOF
  die "dry run failed (exit $code)"
}

step_commit() {
  say "d. COMMIT the backfill (additive: reads v7; writes identity.user and identity.account)"
  confirm "Commit the backfill to database $DATABASE_NAME?"
  local arn code
  arn="$(run_migrator "[\"node\",\"dist/db/identity-v8/cli.js\",\"backfill\",\"--tenant-id\",\"$TENANT_ID\",\"--staff-domains\",\"qnsc.vn\",\"--commit\",\"--database\",\"$DATABASE_NAME\"]")"
  code="$(wait_and_show "$arn")"
  [ "$code" = 0 ] || die "commit failed (exit $code); nothing is half-applied, the backfill is idempotent: fix and re-run this step"

  say "d. invariant check: both counts must be 0 (runs as a one-off task; prints counts only)"
  local inv
  inv='const {Client}=require("pg");const u=new URL(process.env.DATABASE_MIGRATION_URL||process.env.DATABASE_URL);u.searchParams.delete("sslmode");'
  inv+='const c=new Client({connectionString:u.toString(),ssl:{rejectUnauthorized:false}});'
  inv+='(async()=>{await c.connect();'
  inv+='const a=await c.query(`SELECT count(*)::int n FROM identity.users WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM identity.\"user\")`);'
  inv+='const b=await c.query(`SELECT count(*)::int n FROM identity.\"user\" WHERE id NOT IN (SELECT id FROM identity.users WHERE deleted_at IS NULL)`);'
  inv+='console.log("INVARIANT profile_without_login="+a.rows[0].n+" login_without_profile="+b.rows[0].n);await c.end();})()'
  inv+='.catch(e=>{console.error("INVARIANT ERROR "+(e.code||e.message));process.exit(1)});'
  arn="$(run_migrator "[\"node\",\"-e\",$(jq -Rn --arg s "$inv" '$s')]")"
  code="$(wait_and_show "$arn")"
  [ "$code" = 0 ] || die "invariant check failed or could not run (exit $code): read the log above"
  if ! grep -q 'INVARIANT profile_without_login=0 login_without_profile=0' "$LOG"; then
    die "invariant is NOT zero: read the INVARIANT line in the log above"
  fi
  note "PASS: invariant holds (both 0)"
}

step_merge() {
  say "e. PAUSE: merge #718 now"
  note "The SA merges #718 on your go. Do NOT merge it from this script."
  note "After the merge, develop deploys (api, worker, web). Wait until that deploy has SETTLED (the workflow run is green and"
  note "aws ecs wait services-stable has returned)."
  pause "Tell the SA: merge #718. Press Enter here once develop has deployed and settled."
  confirm "Has the develop deploy of #718 settled and the API task run identity 8?"
}

step_verify() {
  say "f. re-run the backfill after the deploy (idempotent), then the verification checklist"
  step_commit
  cat <<'EOF' | tee -a "$LOG"

  Verification (you, in a private window on develop). Mark each one yes or no. Record every no with the time and the request id.
   1. Staff sign-in lands in the home workspace; GET /v1/auth/me returns the same id as before the cutover.
   2. Workspace switch works for a member of two workspaces, and is 403 for one they are not in, and for a deleted one.
   3. A vendor with a live invitation signs in as a guest and sees only what the invitation granted; a guest with none gets
      ?error=STAFF_SIGN_IN_REFUSED on the login page.
   4. An API token minted before the cutover authenticates; after revoke it is 401. Banning the owner (setUserBanned) makes
      their token 401 too.
   5. Sign out and sign-out-everywhere end the session; GET /api/auth/get-session has no "token".
   6. No identity.profile_id_mismatch, identity.auth_handler_threw or identity.context_cache_stale log line.
EOF
  local item
  for item in 1 2 3 4 5 6; do
    ask "Checklist item $item passed? (yes/no)"
    [ "$ANSWER" = yes ] || die "checklist item $item did not pass: fix it, then re-run with --from verify"
  done
  note "all six verification items passed"
}

step_rehearsal() {
  say "g. ROLLBACK REHEARSAL on develop (mirror-bans -> path A -> roll forward -> backfill)"
  note "Place a ban first, through setUserBanned, on a DEVELOP test user. Do not use a real person."
  pause "Place the ban now."

  local arn code
  arn="$(run_migrator '["node","dist/db/identity-v8/cli.js","mirror-bans"]')"
  code="$(wait_and_show "$arn")"; [ "$code" = 0 ] || die "mirror-bans dry run failed (exit $code)"
  confirm "mirror-bans COMMIT (writes identity.users.status for v8 bans)?"
  arn="$(run_migrator "[\"node\",\"dist/db/identity-v8/cli.js\",\"mirror-bans\",\"--commit\",\"--database\",\"$DATABASE_NAME\"]")"
  code="$(wait_and_show "$arn")"; [ "$code" = 0 ] || die "mirror-bans commit failed (exit $code)"

  AFTER_API="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --query 'services[0].taskDefinition' --output text)"
  AFTER_WORKER="$(aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" --query 'services[0].taskDefinition' --output text)"
  note "after-cutover revisions (write them in the runbook table): api $AFTER_API, worker $AFTER_WORKER"
  note "previous revisions (the ones live before the cutover):"
  aws ecs list-task-definitions --family-prefix "$CLUSTER-api" --sort DESC --max-items 6 --query 'taskDefinitionArns' --output text | tr '\t' '\n' | sed 's/^/     /' | tee -a "$LOG"
  ask "Type the PREVIOUS api revision arn (the one before the cutover):"
  PREV_API="$ANSWER"
  ask "Type the PREVIOUS worker revision arn:"
  PREV_WORKER="$ANSWER"

  confirm "PATH A: put the previous api and worker task definitions back on develop (--force-new-deployment)?"
  aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" --task-definition "$PREV_API" --force-new-deployment >/dev/null
  aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --task-definition "$PREV_WORKER" --force-new-deployment >/dev/null
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$API_SERVICE" "$WORKER_SERVICE"
  note "ECS is back on the previous revisions."
  pause "Now roll the SPA back too: Cloudflare Pages, rova-develop-web -> Deployments -> the one before the cutover -> Rollback to this deployment. Press Enter when done."
  pause "Check: staff sign in on v7, the banned user is refused, an API token still works. Press Enter when all three hold."

  confirm "ROLL FORWARD: put the after-cutover revisions back ($AFTER_API, $AFTER_WORKER)?"
  aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" --task-definition "$AFTER_API" --force-new-deployment >/dev/null
  aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --task-definition "$AFTER_WORKER" --force-new-deployment >/dev/null
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$API_SERVICE" "$WORKER_SERVICE"
  pause "Roll the Pages deployment forward to the after-cutover one too. Press Enter when done."

  confirm "Re-run the backfill (idempotent), and confirm the banned user is still banned in v8?"
  step_commit
  pause "Confirm the banned user is still banned in v8 (setUserBanned state). Press Enter when confirmed."
  cat <<EOF | tee -a "$LOG"

  Record the rehearsal in docs/runbooks/identity-v8-cutover.md, the table under "Rehearsal":
  | $(date -u +%F) | <you> | A (mirror-bans, then path A and roll forward) | <minutes> | <surprises> | <result> |
  Revisions used: after = $AFTER_API / $AFTER_WORKER ; previous = $PREV_API / $PREV_WORKER
EOF
}

# ── run ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
discover          # read-only, always: a resumed run needs the names too
run_from preflight && confirm_names
run_from secret && step_secret
run_from backfill-dry && step_backfill_dry
run_from commit && step_commit
run_from merge && step_merge
run_from verify && step_verify
run_from rehearsal && step_rehearsal
say "done. The log is at $LOG (it holds no secret values)."

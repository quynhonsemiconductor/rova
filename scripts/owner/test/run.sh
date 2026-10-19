#!/usr/bin/env bash
# Stub tests for the production path of identity-v8-cutover.sh. Each case builds a throwaway fixture (a git repo holding the script, the
# three flags on main, release tags, and a bare origin), runs the real script against the stub aws and wrangler with scripted answers,
# and checks the exit code, the output, and how many snapshots the stub was asked to create. A broken-input case must STOP.
#
#   bash scripts/owner/test/run.sh          KEEP=1 keeps each case's output file and fixture for reading
#
# Per-case options (environment): SCRIPT_ARGS (e.g. "--from release"), STATE_JSON (the stub's state: snapshots), SCRIPT_STATE (the
# script's saved state: RELEASE_TAG, PRE_SNAPSHOT, TAG_BEFORE, RELEASE_PAUSED), PAGES_JSON (Pages secret names), NO_TAG=1 (no v1.2.3),
# EXTRA_TAG (a second release tag on main), EXPECT_CREATES (snapshots the stub must have been asked to create), and stub switches
# (MOCK_WHOAMI, MOCK_RETENTION, MOCK_PAGES_LIST_FAIL, MOCK_RDS_EXPIRED, MOCK_ACTIVITY_ROWS, MOCK_API_IMAGE_TAG, MOCK_WORKER_IMAGE_TAG,
# MOCK_API_LIVE_REV (11 = v7, 12 = cut over), MOCK_OLD_TAG, MOCK_RELEASE_TAG) and SIDE_TAG (a tag on a commit that is not on origin/main).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../identity-v8-cutover.sh"
STUBS="$HERE/stubs"
WORK="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT
passed=0
failed=0
export TAG_POLL_SECONDS=0 TAG_POLL_TRIES=2

make_fixture() { # make_fixture <dir>
  local dir="$1"
  mkdir -p "$dir/work/scripts/owner" "$dir/work/infra/live/prod"
  cp "$SCRIPT" "$dir/work/scripts/owner/identity-v8-cutover.sh"
  cat > "$dir/work/infra/live/prod/main.tf" <<'TF'
module "stack" {
  better_auth_secret_set         = true
  edge_client_ip_secret_set      = true
  identity_v8_backfill_on_deploy = true
}
TF
  (
    cd "$dir/work" && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=stub commit -q -m fixture
    [ -n "${NO_TAG:-}" ] || git tag v1.2.3
    [ -z "${EXTRA_TAG:-}" ] || git tag "$EXTRA_TAG"
    if [ -n "${SIDE_TAG:-}" ]; then # a tag on a commit that origin/main does not contain
      git checkout -q -b side && echo side > side.txt && git add side.txt && git -c user.email=t@t -c user.name=stub commit -q -m side
      git tag "$SIDE_TAG" && git checkout -q main
    fi
    git clone -q --bare . "$dir/origin.git" && git remote add origin "$dir/origin.git" && git fetch -q origin --tags
  )
}

iso_hours_ago() { python3 -c 'import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=float(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%S.000Z"))' "$1"; }
# snaps <name> <status> <hours ago>: the stub state holding one snapshot
snaps() { python3 -c 'import json,sys; print(json.dumps({"snaps": {sys.argv[1]: {"status": sys.argv[2], "created": sys.argv[3]}}}))' "$1" "$2" "$(iso_hours_ago "$3")"; }

# run_case <name> <want exit> <expect ERE> <refuse ERE> -- <answers, one word per answer>
run_case() {
  local name="$1" want="$2" expect="$3" refuse="$4"; shift 5
  local dir="$WORK/$name" sha code out why="" ok=1 creates
  mkdir -p "$dir/xdg/rova-identity-v8"
  make_fixture "$dir"
  sha="$(git -C "$dir/work" rev-parse HEAD)"
  printf '%s' "${STATE_JSON:-}" > "$dir/state.json"
  [ -s "$dir/state.json" ] || printf '{}' > "$dir/state.json"
  printf '%s' "${PAGES_JSON:-}" > "$dir/pages.json"
  [ -s "$dir/pages.json" ] || printf '[]' > "$dir/pages.json"
  [ -z "${SCRIPT_STATE:-}" ] || printf '%s\n' "$SCRIPT_STATE" > "$dir/xdg/rova-identity-v8/prod-state.env"
  printf '%s\n' "$@" > "$dir/answers.txt"
  out="$dir/out.txt"
  (
    cd "$dir/work" || exit 99
    # shellcheck disable=SC2086  # SCRIPT_ARGS is a list of words by design
    env -i HOME="$HOME" PATH="$STUBS:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
      STUB_STATE="$dir/state.json" STUB_PAGES="$dir/pages.json" MOCK_SHA="$sha" MIGRATOR_MIN_COMMIT="$sha" \
      MOCK_API_LIVE_REV="${MOCK_API_LIVE_REV:-11}" MOCK_OLD_TAG="${MOCK_OLD_TAG:-v1.2.2}" MOCK_RELEASE_TAG="${MOCK_RELEASE_TAG:-v1.2.4}" \
      MOCK_WHOAMI="${MOCK_WHOAMI:-in}" MOCK_RETENTION="${MOCK_RETENTION:-30}" \
      MOCK_PAGES_LIST_FAIL="${MOCK_PAGES_LIST_FAIL:-}" MOCK_RDS_EXPIRED="${MOCK_RDS_EXPIRED:-}" \
      MOCK_ACTIVITY_ROWS="${MOCK_ACTIVITY_ROWS:-}" MOCK_API_IMAGE_TAG="${MOCK_API_IMAGE_TAG:-}" \
      MOCK_WORKER_IMAGE_TAG="${MOCK_WORKER_IMAGE_TAG:-}" TAG_POLL_SECONDS="$TAG_POLL_SECONDS" TAG_POLL_TRIES="$TAG_POLL_TRIES" \
      XDG_STATE_HOME="$dir/xdg" TERM=dumb \
      bash scripts/owner/identity-v8-cutover.sh prod ${SCRIPT_ARGS:-} < "$dir/answers.txt" > "$out" 2>&1
  )
  code=$?
  [ "$code" = "$want" ] || { ok=0; why="exit $code, wanted $want"; }
  if [ -n "$expect" ] && ! grep -Eq -- "$expect" "$out"; then ok=0; why="$why; missing output: $expect"; fi
  if [ -n "$refuse" ] && grep -Eq -- "$refuse" "$out"; then ok=0; why="$why; forbidden output: $refuse"; fi
  if [ -n "${EXPECT_CREATES:-}" ]; then
    creates="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("creates", 0))' "$dir/state.json")"
    [ "$creates" = "$EXPECT_CREATES" ] || { ok=0; why="$why; snapshots created: $creates, wanted $EXPECT_CREATES"; }
  fi
  if [ "$ok" = 1 ]; then
    passed=$((passed + 1)); echo "ok    $name"
  else
    failed=$((failed + 1)); echo "FAIL  $name:${why}"; tail -12 "$out" | sed 's/^/        | /'
    [ -z "${KEEP:-}" ] || echo "        (kept: $out)"
  fi
}

# The prompts of a full prod run, in order: names, secret write, host, Entra pause, edge write, [activity count], announcement, fresh
# snapshot, release-please pause, tag confirmation, deploy pause, commit, the ten checklist items, the second person.
TEN=(yes yes yes yes yes yes yes yes yes yes)

# 1. the full path from the top: the tag appears after the baseline (the script's state carries the baseline, the fixture the new tag)
EXPECT_CREATES=1 SCRIPT_STATE="TAG_BEFORE=v1.2.3" EXTRA_TAG=v1.2.4 \
run_case full-prod 0 "all 10 verification items passed|PASS: v1.2.4 is live" "^STOP" -- \
  yes yes rova.qnsc.vn "" yes yes yes "" yes "" yes "${TEN[@]}" yes

# 2. a resume after the release, snapshot an hour old, tag saved: no pause, no snapshot question, nothing created
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=0 \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="$(printf 'RELEASE_TAG=v1.2.4\nPRE_SNAPSHOT=rova-prod-pre-identity-v8-recent')" \
run_case resume-after-release-saved-tag 0 "PRE_SNAPSHOT rova-prod-pre-identity-v8-recent is available|all 10 verification items passed" \
  "Downtime|Take a fresh|release-please|Tag confirmation" -- "" yes "${TEN[@]}" yes

# 3. the inverted case: a resume AFTER the release with an OLD snapshot that is still available. Nothing is taken or replaced.
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=0 \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-old available 48)" PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="$(printf 'RELEASE_TAG=v1.2.4\nPRE_SNAPSHOT=rova-prod-pre-identity-v8-old')" \
run_case resume-after-release-never-snapshots 0 "no snapshot is taken after the release|all 10 verification items passed" \
  "Take a fresh|replaces it|Downtime" -- "" yes "${TEN[@]}" yes

# 4. a resume after the release-please pause with no saved snapshot: refuse, do not take one
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=0 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="RELEASE_PAUSED=yes" \
run_case resume-after-pause-without-snapshot-refuses 1 "no PRE_SNAPSHOT is saved" "Take a fresh" -- ""

# 5. after the release the saved snapshot is not available: refuse
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=0 \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-busy creating 1)" PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="$(printf 'RELEASE_TAG=v1.2.4\nPRE_SNAPSHOT=rova-prod-pre-identity-v8-busy')" \
run_case resume-after-release-snapshot-not-available 1 "is 'creating', not available" "Take a fresh" -- ""

# 6. before the release: the saved snapshot is recent, so it is reused, not replaced
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=0 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
SCRIPT_STATE="$(printf 'PRE_SNAPSHOT=rova-prod-pre-identity-v8-recent\nTAG_BEFORE=v1.2.3')" \
run_case pre-release-reuses-recent 0 "reusing the saved snapshot rova-prod-pre-identity-v8-recent \(taken [0-9]+ minutes ago\)" "Take a fresh" -- \
  yes yes "" yes "" yes "${TEN[@]}" yes

# 6b. the same recent snapshot, reuse declined: a fresh one is taken, the old one stays in RDS
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=1 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
SCRIPT_STATE="$(printf 'PRE_SNAPSHOT=rova-prod-pre-identity-v8-recent
TAG_BEFORE=v1.2.3')" \
run_case pre-release-reuse-declined-takes-fresh 0 "a fresh snapshot is taken|PASS: snapshot rova-prod-pre-identity-v8-" "reusing the saved" -- \
  yes no yes "" yes "" yes "${TEN[@]}" yes

# 7. before the release: the saved snapshot is two days old, so a fresh one replaces it (nothing is lost before the release)
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 EXPECT_CREATES=1 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-old available 48)" \
SCRIPT_STATE="$(printf 'PRE_SNAPSHOT=rova-prod-pre-identity-v8-old\nTAG_BEFORE=v1.2.3')" \
run_case pre-release-replaces-old "0" "replaces it|PASS: snapshot rova-prod-pre-identity-v8-" "" -- \
  yes yes "" yes "" yes "${TEN[@]}" yes

# 8. an expired session while reading the saved snapshot: a clear stop, never "take a fresh one"
SCRIPT_ARGS="--from release" MOCK_RDS_EXPIRED=1 EXPECT_CREATES=0 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="PRE_SNAPSHOT=rova-prod-pre-identity-v8-old" \
run_case expired-session-stops 1 "ExpiredToken|cannot read snapshot" "Take a fresh|PASS: snapshot" -- yes

# 9. 0132's gate: more than 2,000,000 activity_logs rows stops the release before anything is announced
SCRIPT_ARGS="--from release" MOCK_ACTIVITY_ROWS=2500000 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
run_case activity-logs-over-gate 1 "activity_logs has 2500000 rows" "Downtime|Take a fresh" --

# 10. the release tag was not found after the baseline: the run stops, it does not cut a tag
SCRIPT_ARGS="--from release" PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
run_case no-new-tag-stops 1 "no new release tag reachable from origin/main" "is live:" -- yes yes ""

# 11. the operator rejects the detected tag: nothing is saved as RELEASE_TAG
SCRIPT_ARGS="--from release" EXTRA_TAG=v1.2.4 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
SCRIPT_STATE="$(printf 'PRE_SNAPSHOT=rova-prod-pre-identity-v8-recent\nTAG_BEFORE=v1.2.3\nRELEASE_PAUSED=yes')" \
run_case tag-rejected-by-operator 1 "stopped before: Is v1.2.4 the release tag" "PASS" -- "" no

# 12. a stale saved RELEASE_TAG that is not a tag: stop, and point at the reset
SCRIPT_ARGS="--from release" PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
SCRIPT_STATE="$(printf 'RELEASE_TAG=v9.9.9\nPRE_SNAPSHOT=rova-prod-pre-identity-v8-recent')" \
run_case stale-release-tag-stops 1 "RELEASE_TAG=v9.9.9 is not a tag" "PASS" --

# 13. broken input: the live API runs another build than the tag
EXTRA_TAG=v1.2.4 MOCK_API_IMAGE_TAG=v1.2.2 SCRIPT_STATE="TAG_BEFORE=v1.2.3" \
run_case live-api-not-the-tag-build 1 "the live api runs .*v1.2.2, not the build of v1.2.4" "all 10 verification items passed" -- \
  yes yes rova.qnsc.vn "" yes yes yes "" yes ""

# 14. broken input: the worker runs another build than the tag
EXTRA_TAG=v1.2.4 MOCK_WORKER_IMAGE_TAG=v1.2.2 SCRIPT_STATE="TAG_BEFORE=v1.2.3" \
run_case live-worker-not-the-tag-build 1 "the live worker runs .* not the build of" "all 10 verification items passed" -- \
  yes yes rova.qnsc.vn "" yes yes yes "" yes ""

# 15a. the live guard: the API already injects BETTER_AUTH_SECRET before the snapshot: stop, take nothing
MOCK_API_LIVE_REV=12 SCRIPT_ARGS="--from release" EXPECT_CREATES=0 EXTRA_TAG=v1.2.4 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="TAG_BEFORE=v1.2.3" \
run_case live-guard-cut-over-stops 1 "already injects BETTER_AUTH_SECRET" "Downtime|Take a fresh|Reuse it" -- ""

# 15b. the live guard: the API runs a tag newer than the baseline (a release already landed): stop, take nothing
MOCK_API_IMAGE_TAG=v1.2.5 SCRIPT_ARGS="--from release" EXPECT_CREATES=0 EXTRA_TAG=v1.2.4 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
SCRIPT_STATE="TAG_BEFORE=v1.2.3" \
run_case live-guard-newer-tag-stops 1 "the live API runs v1.2.5, newer than the baseline v1.2.3" "Downtime|Take a fresh" -- ""

# 15c. a saved RELEASE_TAG that exists but is not on origin/main: stop, the tag is not this release
SIDE_TAG=v1.2.5 SCRIPT_ARGS="--from release" PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
SCRIPT_STATE="$(printf 'RELEASE_TAG=v1.2.5
PRE_SNAPSHOT=rova-prod-pre-identity-v8-recent')" \
run_case release-tag-off-main-stops 1 "RELEASE_TAG=v1.2.5 is not a tag reachable from origin/main" "PASS" --

# 15. the anchored match: the release is v1.2.3 and the API runs v1.2.30. A prefix is not the build: the deploy check must stop.
SCRIPT_ARGS="--from release" MOCK_API_IMAGE_TAG=v1.2.30 MOCK_RELEASE_TAG=v1.2.3 PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
SCRIPT_STATE="$(printf 'RELEASE_TAG=v1.2.3\nPRE_SNAPSHOT=rova-prod-pre-identity-v8-recent')" \
run_case anchored-image-match 1 "the live api runs .*v1.2.30, not the build of v1.2.3" "all 10 verification items passed" -- ""

# 16. whoami: unauthenticated, by exit code and with exit 0 (the text decides); the log names the line, not the banner
MOCK_WHOAMI=out-exit run_case whoami-unauthenticated-exit1 1 "wrangler whoami: You are not authenticated" "" --
MOCK_WHOAMI=out-zero run_case whoami-unauthenticated-exit0 1 "wrangler whoami: You are not authenticated" "" --

# 17. the Pages list fails: its error is printed, not swallowed
SCRIPT_ARGS="--from edge" MOCK_PAGES_LIST_FAIL=1 run_case pages-list-error-surfaced 1 "authentication failed \(stub\)" "" --

# 18. retention below 7 days stops before any write
MOCK_RETENTION=5 run_case retention-too-low 1 "BackupRetentionPeriod is '5'" "" -- yes

# 19. the release refuses without the Pages edge secret (the Function would answer 500)
SCRIPT_ARGS="--from release" PAGES_JSON='[]' SCRIPT_STATE="RELEASE_TAG=v1.2.3" STATE_JSON="$(snaps rova-prod-pre-identity-v8-recent available 1)" \
run_case release-needs-pages-secret 1 "has no EDGE_CLIENT_IP_SECRET" "PASS" --

# 20. stdin closes in the middle of a run: a clear stop, not a silent exit
run_case stdin-closed-stops 1 "no answer for:" "" -- yes

echo
echo "$passed passed, $failed failed"
[ "$failed" = 0 ]

#!/usr/bin/env bash
# Stub tests for the production path of identity-v8-cutover.sh. Each case builds a throwaway fixture (a git repo holding the script, the
# three flags on main, a release tag on main, and a bare origin), runs the real script against the stub aws and wrangler with scripted
# answers, and checks the exit code and the output. The broken-input cases must STOP: a PASS there would be the failure.
#
#   bash scripts/owner/test/run.sh          KEEP=1 keeps each case's output file and fixture for reading
#
# Per-case options (environment): SCRIPT_ARGS (e.g. "--from release"), STATE_JSON (the stub's state), SCRIPT_STATE (the script's saved
# state, e.g. RELEASE_TAG=...), PAGES_JSON (Pages secret names), NO_TAG=1 (no release tag on main), EXPECT_CREATES (snapshots the stub must
# have been asked to create), and stub switches (MOCK_WHOAMI, MOCK_RETENTION, MOCK_PAGES_LIST_FAIL, MOCK_LIVE_SHA).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../identity-v8-cutover.sh"
STUBS="$HERE/stubs"
WORK="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT
passed=0
failed=0

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
    git clone -q --bare . "$dir/origin.git" && git remote add origin "$dir/origin.git" && git fetch -q origin --tags
  )
}

iso_hours_ago() { python3 -c 'import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=float(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%S.000Z"))' "$1"; }
snaps_json() { python3 -c 'import json,sys; print(json.dumps({"snaps": {sys.argv[1]: {"status": "available", "created": sys.argv[2]}}}))' "$1" "$2"; }

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
      MOCK_LIVE_SHA="${MOCK_LIVE_SHA:-$sha}" MOCK_WHOAMI="${MOCK_WHOAMI:-in}" MOCK_RETENTION="${MOCK_RETENTION:-30}" \
      MOCK_PAGES_LIST_FAIL="${MOCK_PAGES_LIST_FAIL:-}" XDG_STATE_HOME="$dir/xdg" TERM=dumb \
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

# The prompts of a full prod run, in order: names, secret write, host, Entra pause, edge write, announcement, fresh snapshot,
# release-please pause, deploy pause, commit, the ten checklist items, the second person.
TEN=(yes yes yes yes yes yes yes yes yes yes)

# 1. the full path, from the top, with a fresh snapshot
EXPECT_CREATES=1 run_case full-prod 0 "all 10 verification items passed|PASS: v1.2.3 is live" "^STOP" -- \
  yes yes rova.qnsc.vn "" yes yes yes "" "" yes "${TEN[@]}" yes

# 2. a resume at release, snapshot an hour old, tag saved: no fresh snapshot, no release-please pause, no new tag
SCRIPT_ARGS="--from release" STATE_JSON="$(snaps_json rova-prod-pre-identity-v8-recent "$(iso_hours_ago 1)")" \
PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' SCRIPT_STATE="RELEASE_TAG=v1.2.3" EXPECT_CREATES=0 \
run_case resume-recent-snapshot-saved-tag 0 "reusing snapshot|all 10 verification items passed" \
  "SA: merge the release-please|Take a fresh|take a fresh" -- yes "" yes "${TEN[@]}" yes

# 3. a resume at release, newest snapshot two days old, the operator declines: nothing is created, the run stops
SCRIPT_ARGS="--from release" STATE_JSON="$(snaps_json rova-prod-pre-identity-v8-old "$(iso_hours_ago 48)")" \
PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' SCRIPT_STATE="RELEASE_TAG=v1.2.3" EXPECT_CREATES=0 \
run_case resume-old-snapshot-declined 1 "stopped before: Take a fresh manual snapshot" \
  "SA: merge the release-please" -- yes no

# 4. the same resume, accepted: one fresh snapshot, then the release goes on with the saved tag
SCRIPT_ARGS="--from release" STATE_JSON="$(snaps_json rova-prod-pre-identity-v8-old "$(iso_hours_ago 48)")" \
PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' SCRIPT_STATE="RELEASE_TAG=v1.2.3" EXPECT_CREATES=1 \
run_case resume-old-snapshot-accepted 0 "PASS: snapshot rova-prod-pre-identity-v8-|all 10 verification items passed" \
  "SA: merge the release-please" -- yes yes "" yes "${TEN[@]}" yes

# 5-6. wrangler whoami says unauthenticated: by exit code, and with exit 0 (the text decides)
MOCK_WHOAMI=out-exit run_case whoami-unauthenticated-exit1 1 "not logged in to Cloudflare" "" --
MOCK_WHOAMI=out-zero run_case whoami-unauthenticated-exit0 1 "not logged in to Cloudflare" "" --

# 7. the Pages list fails: its error is printed, not swallowed
SCRIPT_ARGS="--from edge" MOCK_PAGES_LIST_FAIL=1 run_case pages-list-error-surfaced 1 "authentication failed \(stub\)" "" --

# 8. retention below 7 days stops before any write
MOCK_RETENTION=5 run_case retention-too-low 1 "BackupRetentionPeriod is '5'" "" -- yes

# 9. broken input: the live API runs another build than the tag. The release must stop, not report PASS.
MOCK_LIVE_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef \
run_case live-api-not-the-tag-build 1 "the live API runs .* not the build of" "all 10 verification items passed" -- \
  yes yes rova.qnsc.vn "" yes yes yes "" "" ""

# 10. no release tag on main: the script stops, it does not cut one
NO_TAG=1 SCRIPT_ARGS="--from release" STATE_JSON="$(snaps_json rova-prod-pre-identity-v8-recent "$(iso_hours_ago 1)")" \
PAGES_JSON='["EDGE_CLIENT_IP_SECRET"]' \
run_case no-release-tag-stops 1 "no release tag on origin/main" "PASS" -- yes ""

# 11. the release refuses without the Pages edge secret (the Function would answer 500)
SCRIPT_ARGS="--from release" STATE_JSON="$(snaps_json rova-prod-pre-identity-v8-recent "$(iso_hours_ago 1)")" \
PAGES_JSON='[]' SCRIPT_STATE="RELEASE_TAG=v1.2.3" \
run_case release-needs-pages-secret 1 "has no EDGE_CLIENT_IP_SECRET" "PASS" --

# 12. stdin closes in the middle of a run: a clear stop, not a silent exit
run_case stdin-closed-stops 1 "no answer for:" "" -- yes

echo
echo "$passed passed, $failed failed"
[ "$failed" = 0 ]

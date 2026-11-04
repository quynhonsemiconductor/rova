#!/usr/bin/env bash
# =============================================================================
# Container test for the web image (apps/web/Dockerfile + apps/web/Caddyfile).
#
# Builds the image from the repo root, runs it the way the chart runs it (read-only root filesystem,
# a writable /tmp, config.json mounted at /srv/config.json, an arbitrary non-root uid, port 8080),
# and exercises the contract plus the User Guide session gate against a stub API.
#
#   contract      /healthz and /livez 200; doc root /srv; the process runs as the uid asked for
#   caching       / and SPA routes no-cache; an existing /assets/* immutable; a MISSING asset 404
#                 with no Cache-Control promise
#   headers       every value of the Worker's `_headers` on the app, and the same set plus the
#                 guide's overrides on gated responses; no Server fingerprint anywhere
#   redirects     /guide, /guide/en, /guide/assets from public/_redirects
#   gate          302 without a session; 200 + guide headers with one; 503 on 204, on a 200 that is
#                 not JSON, on an upstream 500, on the 5 s timeout and when the API is unreachable
#   bypasses      //guide-assets/x, /assets/../guide-assets/x, /%2e%2e/guide-assets/x,
#                 /guide-assets%2F..%2Fx, /Guide-Assets/x, /guide-assets/, HEAD and POST are each 302
#                 or 404 - never 200 without a session
#   upstream      the gate sends the API only the reader's Cookie (plus its own Accept)
#
# A PASS must fail on broken input: every assertion is a real HTTP response from the image.
#
# Usage (the build needs the GitHub Packages token for @quynhonsemiconductor/*):
#   NODE_AUTH_TOKEN=$(gh auth token) scripts/web-image-test.sh
#
# Containers use this process's PID in their names and are removed on exit; nothing here touches the
# owner's stacks or the default compose project.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
: "${NODE_AUTH_TOKEN:?NODE_AUTH_TOKEN is required (it authenticates the pnpm install in the image build)}"

image="rova-web:test-$$"
stub_image="python:3.13-alpine@sha256:7984cf56ceaddebe4fefeb75d64000b9f45d8b77b11a09b24524da6cdc3af0c8"
net="rova-web-test-net-$$"
stub="rova-web-test-stub-$$"
web="rova-web-test-web-$$"
web_down="rova-web-test-web-down-$$"
tmpdir="$(mktemp -d)"

cleanup() {
  docker rm -f "$web" "$web_down" "$stub" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  docker image rm -f "$image" >/dev/null 2>&1 || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

pass=0
failed=0
ok() { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf '  FAIL  %s: %s\n' "$1" "$2"; }

# The whole response headers of one request, as `curl -D -` prints them.
headers() { curl -sS --max-time 10 --path-as-is -D - -o /dev/null "$@"; }
status() { curl -sS --max-time 10 --path-as-is -o /dev/null -w '%{http_code}' "$@"; }
header_of() {
  local h=$1
  shift
  headers "$@" | tr -d '\r' | grep -i "^$h:" | head -1 | sed 's/^[^:]*:[[:space:]]*//'
}

expect_status() {
  local what=$1 want=$2
  shift 2
  local got
  got="$(status "$@")"
  if [ "$got" = "$want" ]; then ok "$what ($want)"; else bad "$what" "expected $want, got $got"; fi
}

expect_one_of() {
  local what=$1
  local want=$2
  local url=$3
  shift 3
  local got
  got="$(status "$@" "$url")"
  case " $want " in
    *" $got "*) ok "$what ($got)" ;;
    *) bad "$what" "expected one of [$want], got $got" ;;
  esac
}

expect_header() {
  local what=$1 header=$2 want=$3
  shift 3
  local got
  got="$(header_of "$header" "$@")"
  if [ "$got" = "$want" ]; then ok "$what ($header: $want)"; else bad "$what" "expected '$header: $want', got '$got'"; fi
}

expect_no_header() {
  local what=$1 header=$2
  shift 2
  if headers "$@" | tr -d '\r' | grep -qi "^${header}:"; then
    bad "$what" "expected no $header header"
  else
    ok "$what (no $header)"
  fi
}

expect_location() {
  local what=$1 want=$2
  shift 2
  local got
  got="$(header_of 'location' "$@")"
  if [ "$got" = "$want" ]; then ok "$what (Location: $want)"; else bad "$what" "expected Location '$want', got '$got'"; fi
}

# -----------------------------------------------------------------------------
# The stub API. It authenticates exactly what /v1/auth/me reads (a session cookie), accepts the
# gate's header set ONLY, and can answer 204 / a 200 that is not JSON / a slow 200.
# -----------------------------------------------------------------------------
cat > "$tmpdir/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import time

SESSION = "__Host-rova.session_token="
ALLOWED = {"host", "accept", "cookie"}


class Stub(BaseHTTPRequestHandler):
    def do_GET(self):
        cookie = self.headers.get("Cookie", "")
        unexpected = [h for h in self.headers.keys() if h.lower() not in ALLOWED]
        if unexpected:
            self._reply(400, "application/json", b'{"error":"unexpected header"}')
            return
        if "status=500" in cookie:
            self._reply(500, "application/json", b'{"error":"boom"}')
            return
        if "resp=204" in cookie:
            self.send_response(204)
            self.end_headers()
            return
        if "resp=html" in cookie:
            self._reply(200, "text/html", b"<html>not json</html>")
            return
        if "resp=slow" in cookie:
            time.sleep(7)
            self._reply(200, "application/json", b'{"user":{"id":"stub"}}', cookie=True)
            return
        if cookie.startswith(SESSION):
            self._reply(200, "application/json", b'{"user":{"id":"stub"}}', cookie=True)
            return
        self._reply(401, "application/json", b'{"error":"unauthorized"}')

    def _reply(self, status, content_type, body, cookie=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if cookie:
            self.send_header("Set-Cookie", "rova.csrf=rotated; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


HTTPServer(("0.0.0.0", 9000), Stub).serve_forever()
PY

printf '{"apiBaseUrl":"","appEnv":"production","devLoginEnabled":false}' > "$tmpdir/config.json"

echo "== build the image"
docker build -q -f apps/web/Dockerfile --target web \
  --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t "$image" . >/dev/null

echo "== start the stub API and the image (read-only root, uid 12345, config mounted)"
docker network create "$net" >/dev/null
docker run -d --name "$stub" --network "$net" \
  -v "$tmpdir:/app:ro" -w /app "$stub_image" python server.py >/dev/null
docker run -d --name "$web" --network "$net" --read-only --tmpfs /tmp \
  --user 12345 -p 127.0.0.1::8080 \
  -e WEB_API_UPSTREAM=http://"$stub":9000 \
  -v "$tmpdir/config.json:/srv/config.json:ro" "$image" >/dev/null

for _ in $(seq 1 30); do
  port="$(docker port "$web" 8080/tcp 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
: "${port:?the container never answered on 8080}"
base="http://127.0.0.1:$port"
asset="$(docker exec --user 0 "$web" sh -c 'ls /srv/assets | grep -E "^index-.*\.js$" | head -1')"
guide_asset="$(docker exec --user 0 "$web" sh -c 'find /srv/guide-assets -type f | head -1' | sed 's|^/srv||')"
guide_dir="$(docker exec --user 0 "$web" sh -c 'find /srv/guide-assets -type f | head -1' | sed 's|^/srv/guide-assets/||')"

echo "== the image contract"
uid="$(docker exec --user 0 "$web" sh -c 'grep ^Uid /proc/1/status' | awk '{print $2}')"
if [ "$uid" = "12345" ]; then ok "the server runs as the uid the pod asked for (12345)"; else bad "non-root uid" "expected 12345, got $uid"; fi
root="$(docker exec --user 0 "$web" sh -c 'test -f /srv/index.html && echo /srv')"
if [ "$root" = "/srv" ]; then ok "doc root /srv holds index.html"; else bad "doc root" "/srv/index.html is missing"; fi
expect_status "/healthz" 200 "$base/healthz"
expect_status "/livez" 200 "$base/livez"
expect_status "/" 200 "$base/"
expect_status "/config.json (mounted)" 200 "$base/config.json"
expect_status "unknown path falls back to the SPA" 200 "$base/some/spa/route"

echo "== caching"
expect_header "/ is no-cache" cache-control "no-cache" "$base/"
expect_header "/config.json is no-cache" cache-control "no-cache" "$base/config.json"
expect_header "the SPA fallback is no-cache" cache-control "no-cache" "$base/some/spa/route"
expect_header "/$asset is immutable" cache-control "public, max-age=31536000, immutable" "$base/assets/$asset"
expect_status "a missing asset is a 404" 404 "$base/assets/nope.js"
expect_no_header "a missing asset promises nothing (no immutable)" cache-control "$base/assets/nope.js"

echo "== headers (Worker _headers parity), on the app"
app_csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https://69e52835cf2d08edde5b6ebd741d30fa.r2.cloudflarestorage.com https://rova-assets-dev.qnsc.vn https://rova-assets.qnsc.vn; connect-src 'self' blob: https://69e52835cf2d08edde5b6ebd741d30fa.r2.cloudflarestorage.com; worker-src blob:; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://login.microsoftonline.com;"
expect_header "nosniff" x-content-type-options "nosniff" "$base/"
expect_header "clickjacking" x-frame-options "DENY" "$base/"
expect_header "referrer" referrer-policy "no-referrer" "$base/"
expect_header "permissions" permissions-policy "camera=(), microphone=(), geolocation=()" "$base/"
expect_header "HSTS" strict-transport-security "max-age=31536000; includeSubDomains" "$base/"
expect_header "CSP" content-security-policy "$app_csp" "$base/"
expect_no_header "no Server fingerprint" Server "$base/"

echo "== the old User Guide redirects"
expect_status "/guide" 301 "$base/guide"
expect_location "/guide" "/user-guide/vi" "$base/guide"
expect_location "/guide/en/x" "/user-guide/en/x" "$base/guide/en/x"
expect_location "/guide/assets/a.png" "/guide-assets/a.png" "$base/guide/assets/a.png"

echo "== the User Guide session gate"
expect_status "no session cookie" 302 "$base$guide_asset"
expect_location "no session cookie" "/login?returnTo=/user-guide" "$base$guide_asset"
# The stub rejects any header but Host/Accept/Cookie, so this 200 proves the gate forwards only the
# reader's Cookie.
expect_status "session cookie (only Cookie reaches the API)" 200 -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated file is private" cache-control "private, no-cache" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "the API's Set-Cookie reaches the reader" set-cookie "rova.csrf=rotated; Path=/" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
guide_csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"
expect_header "gated: narrow CSP" content-security-policy "$guide_csp" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated: same-origin referrer" referrer-policy "same-origin" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated: nosniff" x-content-type-options "nosniff" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated: clickjacking" x-frame-options "DENY" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated: permissions" permissions-policy "camera=(), microphone=(), geolocation=()" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated: HSTS" strict-transport-security "max-age=31536000; includeSubDomains" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated: noindex" x-robots-tag "noindex, nofollow" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_no_header "gated: no Server fingerprint" Server -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
# The redirect carries the same policy: a refused reader is not a page anyone should index or cache.
expect_header "the 302 is private too" cache-control "private, no-cache" "$base$guide_asset"
expect_header "the 302 is same-origin referrer" referrer-policy "same-origin" "$base$guide_asset"

echo "== the gate fails closed"
expect_status "the API answers 204" 503 -H 'Cookie: resp=204' "$base$guide_asset"
expect_status "the API answers 200 but not JSON" 503 -H 'Cookie: resp=html' "$base$guide_asset"
expect_status "the API answers 500" 503 -H 'Cookie: status=500' "$base$guide_asset"
expect_status "the API misses the 5 s budget" 503 -H 'Cookie: resp=slow' "$base$guide_asset"

echo "== bypass attempts (each 302 or 404, never 200 without a session)"
expect_one_of "//guide-assets/..." "302 404" "$base//guide-assets/$guide_dir"
expect_one_of "/assets/../guide-assets/..." "302 404" "$base/assets/../guide-assets/$guide_dir"
expect_one_of "/%2e%2e/guide-assets/..." "302 404" "$base/%2e%2e/guide-assets/$guide_dir"
expect_one_of "/guide-assets%2F..%2Fx" "302 404" "$base/guide-assets%2F..%2Fx"
expect_one_of "/Guide-Assets/..." "302 404" "$base/Guide-Assets/$guide_dir"
expect_one_of "/guide-assets/ (trailing slash)" "302 404" "$base/guide-assets/"
expect_one_of "HEAD /guide-assets/..." "302 404" "$base$guide_asset" --head
expect_one_of "POST /guide-assets/..." "302 404" "$base$guide_asset" -X POST

echo "== the API unreachable"
docker run -d --name "$web_down" --network "$net" --read-only --tmpfs /tmp \
  --user 12345 -p 127.0.0.1::8080 -e WEB_API_UPSTREAM=http://127.0.0.1:9 \
  -v "$tmpdir/config.json:/srv/config.json:ro" "$image" >/dev/null
for _ in $(seq 1 30); do
  down_port="$(docker port "$web_down" 8080/tcp 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  [ -n "$down_port" ] && curl -sf "http://127.0.0.1:$down_port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
expect_status "the API is unreachable (fail closed)" 503 "http://127.0.0.1:${down_port:?}$guide_asset"

echo
echo "== $pass passed, $failed failed"
[ "$failed" -eq 0 ]

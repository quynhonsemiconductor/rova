#!/usr/bin/env bash
# =============================================================================
# Container test for the web image (apps/web/Dockerfile + apps/web/Caddyfile).
#
# Builds the image from the repo root, runs it the way the chart runs it (read-only root filesystem,
# a writable /tmp, config.json mounted at /srv/config.json, an arbitrary non-root uid, port 8080),
# and exercises the contract plus the User Guide session gate against a stub API:
#
#   /healthz                     200
#   /, a SPA route               index.html, no-cache, the Worker's security headers, no Server header
#   /assets/*                    immutable
#   /config.json                 the mounted file, no-cache
#   /guide, /guide/en, …         the old User Guide redirects
#   /guide-assets/*  no session  302 to /login?returnTo=/user-guide
#   /guide-assets/*  session     200, private/no-cache, the guide's own CSP
#   /guide-assets/*  API 500     503 (fail closed)
#   /guide-assets/*  API down    503 (fail closed)
#
# A PASS must fail on broken input: every assertion below is a real HTTP response from the image.
#
# Usage (build needs the GitHub Packages token for @quynhonsemiconductor/*):
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
headers() { curl -sS -D - -o /dev/null "$@"; }
status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

expect_status() {
  local what=$1 want=$2
  shift 2
  local got
  got="$(status "$@")"
  if [ "$got" = "$want" ]; then ok "$what ($want)"; else bad "$what" "expected $want, got $got"; fi
}

expect_header() {
  local what=$1 header=$2 want=$3
  shift 3
  local got
  got="$(headers "$@" | tr -d '\r' | grep -i "^${header}:" | head -1 | sed 's/^[^:]*:[[:space:]]*//')"
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
  got="$(headers "$@" | tr -d '\r' | grep -i '^location:' | head -1 | sed 's/^[^:]*:[[:space:]]*//')"
  if [ "$got" = "$want" ]; then ok "$what (Location: $want)"; else bad "$what" "expected Location '$want', got '$got'"; fi
}

# The upstream the gate asks: 401 without a session cookie, 200 JSON with one, 500 with `status=500`.
cat > "$tmpdir/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer


class Stub(BaseHTTPRequestHandler):
    def do_GET(self):
        cookie = self.headers.get("Cookie", "")
        if "status=500" in cookie:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"boom"}')
            return
        if "session_token=" in cookie:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"user":{"id":"stub"}}')
            return
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"unauthorized"}')

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
  -v "$tmpdir:/app:ro" -w /app python:3.13-alpine python server.py >/dev/null
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

echo "== the image contract"
uid="$(docker exec --user 0 "$web" sh -c 'grep ^Uid /proc/1/status' | awk '{print $2}')"
if [ "$uid" = "12345" ]; then ok "the server runs as the uid the pod asked for (12345)"; else bad "non-root uid" "expected 12345, got $uid"; fi
root="$(docker exec --user 0 "$web" sh -c 'test -f /srv/index.html && echo /srv')"
if [ "$root" = "/srv" ]; then ok "doc root /srv holds index.html"; else bad "doc root" "/srv/index.html is missing"; fi

expect_status "/healthz" 200 "$base/healthz"
expect_status "/" 200 "$base/"
expect_header "/ is no-cache" cache-control "no-cache" "$base/"
expect_header "security headers present" x-frame-options "DENY" "$base/"
expect_no_header "no Server fingerprint" Server "$base/"
expect_header "/$asset is immutable" cache-control "public, max-age=31536000, immutable" "$base/assets/$asset"
expect_status "/config.json (mounted, no-cache)" 200 "$base/config.json"
expect_header "/config.json is no-cache" cache-control "no-cache" "$base/config.json"
expect_status "unknown path falls back to the SPA" 200 "$base/some/spa/route"
expect_header "the fallback is no-cache" cache-control "no-cache" "$base/some/spa/route"

echo "== the old User Guide redirects"
expect_status "/guide" 301 "$base/guide"
expect_location "/guide" "/user-guide/vi" "$base/guide"
expect_location "/guide/en/x" "/user-guide/en/x" "$base/guide/en/x"
expect_location "/guide/assets/a.png" "/guide-assets/a.png" "$base/guide/assets/a.png"

echo "== the User Guide session gate"
expect_status "no session cookie" 302 "$base$guide_asset"
expect_location "no session cookie" "/login?returnTo=/user-guide" "$base$guide_asset"
expect_status "session cookie" 200 -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated file is private" cache-control "private, no-cache" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_header "gated file has the guide CSP" content-security-policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'" -H 'Cookie: __Host-rova.session_token=stub' "$base$guide_asset"
expect_status "the API answers 500 (fail closed)" 503 -H 'Cookie: status=500' "$base$guide_asset"

docker run -d --name "$web_down" --network "$net" --read-only --tmpfs /tmp \
  --user 12345 -p 127.0.0.1::8080 -e WEB_API_UPSTREAM=http://127.0.0.1:9 \
  -v "$tmpdir/config.json:/srv/config.json:ro" "$image" >/dev/null
for _ in $(seq 1 30); do
  down_port="$(docker port "$web_down" 8080/tcp 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  [ -n "$down_port" ] && curl -sf "http://127.0.0.1:$down_port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
expect_status "the API is unreachable (fail closed)" 503 "http://127.0.0.1:${down_port:?}${guide_asset}"

echo
echo "== $pass passed, $failed failed"
[ "$failed" -eq 0 ]

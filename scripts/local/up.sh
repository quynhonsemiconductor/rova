#!/usr/bin/env bash
# `make local`: the infrastructure, the migrations and the local fixtures, then the API, the worker and the web app.
# Every process logs to .local/<name>.log. Stop everything with `make down`. Needs Docker, Node 22+, pnpm and NODE_AUTH_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -f .env ] || cp .env.example .env
port=$(grep -E '^PORT=' .env | cut -d= -f2)
port=${port:-3010}

mkdir -p .local
docker compose -f docker-compose.dev.yml up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed

start() {
  local name=$1
  shift
  nohup "$@" >".local/$name.log" 2>&1 &
  echo $! >".local/$name.pid"
}
start api pnpm start:dev
start worker pnpm start:dev:worker
start web pnpm --filter rova-web dev

for _ in $(seq 1 180); do
  curl -sf "http://localhost:${port}/readyz" >/dev/null && break
  sleep 1
done
curl -sf "http://localhost:${port}/readyz" >/dev/null || {
  echo "The API did not become ready: see .local/api.log" >&2
  exit 1
}
echo "Stack is up. Check it with: make check   (logs: .local/*.log, stop with: make down)"

#!/usr/bin/env bash
# Runs the backend e2e suite against an ISOLATED stack: its own compose project, the e2e port block, a migrated and reset database.
#
#   scripts/e2e/run.sh [vitest args...]        # whole suite, or the files you name
#   E2E_KEEP=1 scripts/e2e/run.sh              # leave the stack up afterwards (default: `down`, volumes kept)
#
# Never run this against a stack you did not start: the suite truncates the database it points at.
set -euo pipefail
cd "$(dirname "$0")/../.."

env_file=.env.e2e
node scripts/e2e/make-env.mjs "$env_file" >/dev/null
project=$(grep -E '^COMPOSE_PROJECT_NAME=' "$env_file" | cut -d= -f2)

docker compose -p "$project" --env-file "$env_file" -f docker-compose.dev.yml up -d --wait

# Migrations and the reset read the env as plain shell variables (they do not load .env themselves).
set -a
. "./$env_file"
set +a
pnpm db:migrate

E2E_ENV_FILE="$env_file" pnpm exec vitest run --config test/vitest.e2e.config.ts "$@" || status=$?

if [ "${E2E_KEEP:-0}" != 1 ]; then
  docker compose -p "$project" --env-file "$env_file" -f docker-compose.dev.yml down
fi
exit "${status:-0}"

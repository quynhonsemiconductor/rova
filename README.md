# Rova

Single-tenant project-management application. Runs on **ECS Fargate** (AWS), per the [platform architecture](https://github.com/quynhonsemiconductor/.github/blob/main/docs/PLATFORM_ARCHITECTURE.md).

> **Not multi-tenant.** Rova was built as a multi-tenant SaaS and stopped being one on 2026-07-09, when `tenant` was merged into `workspace` ([design](docs/superpowers/specs/2026-07-09-drop-multi-tenant-merge-into-workspace-design.md)). `workspace` is now the switchable root; users are global and join workspaces via `workspace_members`. The deployment seeds exactly one workspace (`db/seeds/bootstrap.ts`), so in practice the boundary that separates users is **project**, enforced by `PolicyGuard`. There is no RLS and no DB-level isolation — see the ratchets in `test/workspace-scope.ratchet.spec.ts` and `test/route-policy.ratchet.spec.ts` for what holds that line instead.

> **Monorepo.** Consolidates the former `rally-api` + `rally-web` + `rally-infra` into one repository per [REPOSITORY_STRUCTURE.md](https://github.com/quynhonsemiconductor/.github/blob/main/docs/REPOSITORY_STRUCTURE.md). Old repos are archived (read-only) for history.

## Layout

```
rova/
├── apps/
│   ├── api/       # NestJS 11 (Fastify) HTTP API — ECS Fargate service
│   ├── worker/    # NestJS background/queue worker — ECS Fargate service
│   └── web/       # React 19 + Vite SPA — S3 + CloudFront (pnpm workspace member)
├── libs/          # shared backend libs (shared-kernel, platform, contracts, 12 domain modules)
│                  #   ↳ this is the design's "packages/" role, using the NestJS `libs/` convention
├── db/            # Drizzle schema + migrations + seeds
├── deploy/ecs/    # deploy-descriptor notes (task-def is infra-owned — see deploy/ecs/README.md)
├── infra/         # OpenTofu (product-owned resources), sources tf-modules via git ref
│   └── live/{_shared,develop,prod}/
├── .github/workflows/   # CI/CD — calls reusable workflows/actions from quynhonsemiconductor/ci
├── Dockerfile     # multi-target: api, worker, migrator (web is static, no container)
└── pnpm-workspace.yaml
```

## Workspace model

- The **NestJS backend** (`apps/api`, `apps/worker`, `libs/`, `db/`) is the **root package** — resolved by `nest-cli.json` (`monorepo: true`) + tsconfig path aliases (`@shared-kernel`, `@platform`, `@contracts`, `@modules/*`). It is **not** a set of pnpm workspace packages.
- `apps/web` is the **one pnpm workspace member** (separate Vite toolchain, package name `rova-web`).
- `pnpm-workspace.yaml` lists only `apps/web`; the backend is the root.

## Local stack

A clean clone runs with **`cp .env.example .env` and the commands below, nothing else**. CI proves it on every PR (the `local quickstart` job boots exactly this) and `test/env-example.spec.ts` checks `.env.example` against the env schema and the dev tooling.

**You need:** Docker with Compose v2, Node 24 (`.nvmrc`), pnpm (the version in `package.json` `packageManager`; pnpm 10 fetches it for you), and a GitHub token that can read the org's packages: the shared `@quynhonsemiconductor/*` libraries install from GitHub Packages. **Do not mint a personal PAT**: reuse your GitHub CLI login (`gh auth login`, needs the `read:packages` scope).

```bash
# Once per machine. pnpm 11+ ignores a token written in a project .npmrc (that file is committed, so an environment
# variable in it could leak to a registry the repo names), but expands one in your user-level file, on every version.
grep -qs 'npm.pkg.github.com/:_authToken' ~/.npmrc || echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> ~/.npmrc

export NODE_AUTH_TOKEN="$(gh auth token)"      # per shell (or wire via direnv)
cp .env.example .env                           # every value is already wired, secrets are local placeholders
docker compose -f docker-compose.dev.yml up -d --wait    # Postgres, Valkey, LocalStack (S3), OTel collector
pnpm install                                   # root (backend) + apps/web
pnpm db:migrate                                # migrations + the RBAC catalogue + the demo users (SEED_ON_DEPLOY=true in .env)
```

Then one terminal per process:

```bash
pnpm start:dev          # API    → http://localhost:3000   (/readyz, /v1/*, /api/docs)
pnpm start:dev:worker   # worker → relays and cron jobs; serves no HTTP
pnpm dev:web            # SPA    → http://localhost:5173   (proxies /v1 to :3000)
```

Check it: `curl -s localhost:3000/readyz` answers `{"status":"ok", …}` (the API's own probe), and `curl -s localhost:5173/v1/healthz` answers **through the SPA's proxy**, which is what proves Vite and the API agree on the port.

The API and the worker validate against one schema, so one `.env` serves both and neither refuses the other's variables. `.env.example` marks every variable `[both]`, `[API]`, `[WORKER]` or `[web]`. The repo-root `.env` also serves the SPA (Vite exposes only `VITE_`-prefixed variables), so there is no second file to create.

### Sign in

The login page has a "Sign in with Microsoft" button and, because `.env.example` sets `VITE_DEV_LOGIN=true`, a passwordless **dev login**: an email field for a seeded account, backed by identity's `POST /api/auth/test-login`. It is for local and non-production use only: identity loads that route only with `IDENTITY_TEST_LOGIN=enabled` AND `NODE_ENV` of `test` or `development`, and the env schema refuses it in production. The demo users `db:migrate` seeded:

| email | role |
| --- | --- |
| `admin@qnsc.dev` | workspace_admin (platform admin) |
| `dev@qnsc.dev` | no workspace-wide role (0 permissions): a member of Team Alpha, assigned the sample work items |
| `viewer@qnsc.dev` | the same, as the read-only fixture |

**In the browser:** open http://localhost:5173, type `admin@qnsc.dev` in the dev-login field and submit.

**With curl** (an API call without a browser; the session is an opaque `__Secure-rova.session_token` cookie; a cookie jar will not send a `Secure` cookie over http, so replay it by hand):

```bash
cookie=$(curl -s -D - -o /dev/null -H 'content-type: application/json' -d '{"email":"admin@qnsc.dev"}' localhost:3000/api/auth/test-login \
  | sed -n 's/^set-cookie: \(__Secure-rova.session_token=[^;]*\).*/\1/ip' | tr -d '\r')
curl -s -H "cookie: $cookie" localhost:3000/v1/auth/me
```

**With Microsoft (optional).** The env schema requires `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` and `ENTRA_CLIENT_SECRET` in every environment, so `.env.example` carries placeholders that let the API boot and sign nobody in. To use Microsoft locally, register a **dev** app in a tenant you control, separate from production's: platform *Web*, redirect URI `http://localhost:5173/api/auth/callback/microsoft`, delegated `openid profile email`, and a client secret. Put the real tenant id, client id and secret in `.env` and restart the API. The redirect is on the SPA origin because the browser lands there and the session cookie is set on that response.

### Ports, and running beside opshub

These are the defaults. opshub's stack is offset from them (API 3001, Postgres 5433, Valkey 6380, LocalStack 4567, OTel 4319/8890) so both run at once. The two SPAs are the exception: both want 5173.

| | rova | opshub |
| --- | --- | --- |
| API | 3000 | **3001** |
| SPA (Vite) | 5173 | 5173 |
| Postgres | 5432 | **5433** |
| Valkey | 6379 | **6380** |
| LocalStack (S3) | 4566 | **4567** |
| OTel collector (OTLP / Prometheus) | 4318 / 8889 | **4319** / **8890** |

The Vite server uses `strictPort`: a second SPA fails with "Port 5173 is already in use" instead of quietly moving to 5174, where the sign-in redirect (`APP_BASE_URL`, whose `/api/auth/callback/microsoft` is the Entra redirect URI) and the upload bucket's CORS would no longer match. To run both SPAs, start one of them elsewhere and tell **its** API the new origin on the command line (a variable in the environment beats `.env`):

```bash
APP_BASE_URL=http://localhost:5174 CORS_ORIGINS=http://localhost:5174 pnpm start:dev
pnpm dev:web --port 5174
```

(File uploads in the browser need LocalStack's bucket CORS to allow that origin too: `WEB_ORIGIN` in `scripts/localstack/01-bootstrap.sh`.)

### Run a second copy

Two checkouts, or a branch you want to keep running beside your main one, need their own compose project, host ports, and
API and web ports. Every port is bound to `127.0.0.1` and read from `.env`. In the second copy's `.env`:

1. `COMPOSE_PROJECT_NAME=rova-2`: the containers, volumes and network take this prefix. Every checkout or worktree sets its own.
2. Give each `*_HOST_PORT` a free number: `POSTGRES_HOST_PORT`, `VALKEY_HOST_PORT`, `LOCALSTACK_HOST_PORT`, `OTEL_OTLP_HOST_PORT`, `OTEL_METRICS_HOST_PORT`.
3. Put the same Postgres, Valkey and LocalStack numbers into `DATABASE_URL`, `REDIS_URL`, `STORAGE_ENDPOINT`, `AWS_ENDPOINT_URL`, and the OTLP port into `OTEL_EXPORTER_OTLP_ENDPOINT`. The app reads URLs, not the `*_HOST_PORT` values.
4. The API: `PORT`. The SPA's proxy and the dev CSP follow it (or set `API_TARGET` to point the proxy somewhere else).
5. The web: `WEB_DEV_PORT`. LocalStack's bucket CORS follows it. Then `APP_BASE_URL=http://localhost:<WEB_DEV_PORT>` and `CORS_ORIGINS=http://localhost:<WEB_DEV_PORT>`, so sign-in redirects and the API's CORS match the new origin.

Then run the same commands as above. The Playwright config's `baseURL` is pinned to 5173, so `pnpm --filter rova-web test:e2e` runs in one copy at a time.

### Useful

- `pnpm db:seed` loads only the baseline (roles, workspace, the platform admin); `pnpm db:seed:test` adds the one-project demo fixture; `pnpm db:studio` opens Drizzle Studio.
- Telemetry: `docker compose -f docker-compose.dev.yml logs otel`, or `curl -s localhost:8889/metrics | grep queue_`. No collector? `OTEL_ENABLED=false` in `.env`.
- Mail is `EMAIL_PROVIDER=dev`: messages are written to the API log and not sent (`LOG_DEV_EMAIL_CONTENT=true` includes the body, links included).
- Uploads go to LocalStack's `rova-attachments` and `rova-public-assets` buckets; `aws --endpoint-url http://localhost:4566 s3 ls` (any credentials).
- Reset everything: `docker compose -f docker-compose.dev.yml down -v`, then `up -d --wait` and `pnpm db:migrate` again.
- Upgrading an existing checkout (before `name: rova`): the containers were named `rova-postgres`, `rova-valkey`, `rova-localstack` and `rova-otel`, outside any project. Remove them with `docker rm -f rova-postgres rova-valkey rova-localstack rova-otel`, or `docker compose -p <old project dir> down -v`. The Postgres volume itself stays 17, so no data move is needed. Do not share a project name between checkouts: `down -v` in one would wipe the other's data.
- Least-privilege database roles locally, the way CI runs: see the comment above `DATABASE_URL` in `.env.example`.
- Tests: `pnpm test` (unit), `pnpm test:e2e` (needs the stack and a migrated, seeded database).

## Build

```bash
pnpm build                   # api + worker (nest build)
pnpm build:web               # web (tsc + vite build → apps/web/dist)
```

## Deploy (ECS Fargate)

Push-based CD via GitHub Actions → `quynhonsemiconductor/ci` reusable workflows/actions:
`build → Trivy scan → Cosign sign → push ECR → register task-def revision → update-service → health check`.
Promotion `develop → prod` is a tagged release. See `.github/workflows/` and `deploy/ecs/README.md`.

## Infra

`infra/live/{develop,prod}` compose modules from [`tf-modules`](https://github.com/quynhonsemiconductor/tf-modules) (ecs-cluster, ecs-service, rds, messaging, secrets, pages-web, dns-record). The shared VPC/NAT/ALB (+ prod cache/WAF) live once per env in `infra` (`platform/runtime-dev` / `runtime-prod`) and are consumed via `terraform_remote_state`; RDS + Fargate stay per-product (dev cache is a per-product single-node `cache.t4g.micro` ElastiCache — it survives task replacement so BFF sessions persist across deploys). State in S3 + DynamoDB (shared bootstrap). `infra/live/_shared` holds per-product ECR repos + GitHub OIDC deploy roles.

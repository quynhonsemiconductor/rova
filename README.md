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

## Develop

The shared `@quynhonsemiconductor/*` libraries (e.g. `@quynhonsemiconductor/identity`) are hosted on **GitHub Packages**, which requires read auth. **Do not mint a personal PAT** — reuse your existing GitHub CLI login (needs the `read:packages` scope):

```bash
gh auth login                                        # one-time, if not already
export NODE_AUTH_TOKEN="$(gh auth token)"            # per shell (or wire via direnv)
```

CI needs no setup — workflows authenticate with the built-in `GITHUB_TOKEN` (`packages: read`).

```bash
pnpm install                 # installs root (backend) + apps/web
docker compose -f docker-compose.dev.yml up -d   # local Postgres + Redis
pnpm db:migrate              # apply Drizzle migrations
pnpm start:dev               # api (watch)   |  pnpm start:dev:worker
pnpm dev:web                 # web (Vite dev server)
```

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

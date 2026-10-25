# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# =============================================================================
# Rova API — Production Dockerfile
# =============================================================================
# Targets:
#   api       → HTTP API server          (default / most common)
#   worker    → Background job processor
#   migrator  → One-shot Drizzle migration runner (CI gate job)
#
# Build examples:
#   docker build --target api      -t rally-api:latest .
#   docker build --target worker   -t rally-worker:latest .
#   docker build --target migrator -t rally-migrator:latest .
#
# Performance notes:
#   - BuildKit cache mounts keep the pnpm store between builds (no re-download)
#   - deps   stage: ALL packages — needed to compile TypeScript
#   - prod-deps stage: only production packages — goes into the final image
#   - builder stage: compiles libs + apps into dist/
#   - api / worker / migrator stages: minimal runtime images
# =============================================================================

ARG NODE_VERSION=24
ARG ALPINE_VERSION=3.22
# Keep equal to `packageManager` in package.json and to PNPM_VERSION in the workflows.
ARG PNPM_VERSION=11.28.5

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 │ deps
# Install ALL packages (dev + prod) so the builder has everything it needs.
# The pnpm store is cached via BuildKit so subsequent builds skip downloads.
#
# Registry auth: pnpm 11 ignores `${NODE_AUTH_TOKEN}` in the committed project .npmrc, so each install
# step writes a USER-level npmrc (NPM_CONFIG_USERCONFIG, a fresh mktemp file) holding the same
# placeholder line. The file never contains the token: pnpm expands it from the NODE_AUTH_TOKEN
# environment variable, which exists only inside that RUN (read from the BuildKit secret).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS deps
ARG PNPM_VERSION

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
COPY patches ./patches

RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=secret,id=node_auth_token \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" && \
    pnpm config set store-dir /root/.local/share/pnpm/store && \
    export NPM_CONFIG_USERCONFIG="$(mktemp)" && \
    printf '%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > "$NPM_CONFIG_USERCONFIG" && \
    HUSKY=0 pnpm install --frozen-lockfile && \
    rm -f "$NPM_CONFIG_USERCONFIG"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 │ prod-deps
# Install production-only packages — this slim node_modules goes into the
# final API and worker images.  Runs in parallel with the builder stage.
# ─────────────────────────────────────────────────────────────────────────────
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS rds-ca
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /bundle.pem
RUN chmod 0644 /bundle.pem

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS prod-deps
ARG PNPM_VERSION

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
COPY patches ./patches

RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=secret,id=node_auth_token \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" && \
    pnpm config set store-dir /root/.local/share/pnpm/store && \
    export NPM_CONFIG_USERCONFIG="$(mktemp)" && \
    printf '%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > "$NPM_CONFIG_USERCONFIG" && \
    pnpm install --frozen-lockfile --prod --ignore-scripts && \
    rm -f "$NPM_CONFIG_USERCONFIG"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 │ builder
# Compile the full NestJS monorepo.  Uses the ALL-deps node_modules so the
# TypeScript compiler and NestJS CLI plugins are available.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS builder
ARG PNPM_VERSION

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# pnpm 11 runs an implicit `install` before every script when node_modules does not match the workspace.
# Here it never does, on purpose: node_modules is copied from `deps` (root package only), while the full
# source below includes apps/web, whose dependencies this image does not install. The check would try to
# install the whole workspace for every `pnpm build:*` below, and fail on registry auth (the builder has
# no token). pnpm 10 did not check; the build needs no install, so say so.
ENV pnpm_config_verify_deps_before_run=false

WORKDIR /app

# Reuse installed packages — no re-install needed
COPY --from=deps /app/node_modules ./node_modules

# Copy full source (respects .dockerignore — no node_modules/dist/secrets)
COPY . .

# Compile API  →  dist/apps/api/
RUN pnpm build:api

# Compile Worker  →  dist/apps/worker/
# Worker tsconfig mirrors the API fix: libs included, no spec files
RUN pnpm build:worker

# Compile Migrator  →  dist/db/
# Pre-compiling eliminates tsx (and its embedded esbuild Go binaries) from the
# migrator runtime image, removing the CVE surface without .trivyignore suppression.
RUN pnpm build:migrator

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 │ api  (default production target)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS api

# Upgrade all Alpine packages to latest security patches within the pinned
# Alpine version, and remove the base image's global npm — it is unused at
# runtime (the app runs via `node dist/...`) and its bundled node-tar carries a
# CRITICAL CVE (CVE-2026-59873) that apk upgrade cannot patch. Ensures Trivy
# finds no CRITICAL/HIGH CVEs with available fixes.
RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
    && rm -rf /var/cache/apk/*

# Runtime tunables — override via docker run -e or Kubernetes env
ENV NODE_ENV=production
# The RDS global CA bundle (public certificates only) for DATABASE_SSL_CA. The
# default points at the baked file; a task definition may override it (on-prem:
# the CNPG ca.crt). Fetched at build time, unpinned on purpose: the bundle gains
# CAs over time and a stale local copy would fail verification against new
# instances instead of being silently wrong. Own stage so it is fetched once and
# lands world-readable: a remote ADD is root-owned 0600, and the runtime users
# (nestjs/migrator) must read it.
COPY --from=rds-ca /bundle.pem /etc/ssl/rds-global-bundle.pem
ENV DATABASE_SSL_CA=/etc/ssl/rds-global-bundle.pem

ENV NODE_OPTIONS="--max-old-space-size=512"
ENV PORT=3000
ENV HOST=0.0.0.0

WORKDIR /app

# Production node_modules (no devDeps → smaller image)
COPY --from=prod-deps /app/node_modules ./node_modules

# Compiled output: libs are baked into dist/apps/api/ (single output tree)
COPY --from=builder /app/dist/apps/api ./dist/apps/api

# package.json needed by NestJS for version metadata
COPY --from=builder /app/package.json ./

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 nestjs \
    && chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 3000

# tini reaps zombies and forwards signals properly (important for graceful shutdown)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/apps/api/apps/api/src/main.js"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/v1/healthz || exit 1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 5 │ worker
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS worker

RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production
# The RDS global CA bundle (public certificates only) for DATABASE_SSL_CA. The
# default points at the baked file; a task definition may override it (on-prem:
# the CNPG ca.crt). Fetched at build time, unpinned on purpose: the bundle gains
# CAs over time and a stale local copy would fail verification against new
# instances instead of being silently wrong. Own stage so it is fetched once and
# lands world-readable: a remote ADD is root-owned 0600, and the runtime users
# (nestjs/migrator) must read it.
COPY --from=rds-ca /bundle.pem /etc/ssl/rds-global-bundle.pem
ENV DATABASE_SSL_CA=/etc/ssl/rds-global-bundle.pem

ENV NODE_OPTIONS="--max-old-space-size=256"

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder   /app/dist/apps/worker ./dist/apps/worker
COPY --from=builder   /app/package.json ./

RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 nestjs \
    && chown -R nestjs:nodejs /app

USER nestjs

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/apps/worker/apps/worker/src/main.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 6 │ migrator
# One-shot container: runs Drizzle migrations then exits.
# Use as a CI gate job before deploying a new API version.
#
# Usage:
#   docker run --rm \
#     -e DATABASE_MIGRATION_URL="postgresql://..." \
#     rally-migrator:latest
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS migrator

RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production
# The RDS global CA bundle (public certificates only) for DATABASE_SSL_CA. The
# default points at the baked file; a task definition may override it (on-prem:
# the CNPG ca.crt). Fetched at build time, unpinned on purpose: the bundle gains
# CAs over time and a stale local copy would fail verification against new
# instances instead of being silently wrong. Own stage so it is fetched once and
# lands world-readable: a remote ADD is root-owned 0600, and the runtime users
# (nestjs/migrator) must read it.
COPY --from=rds-ca /bundle.pem /etc/ssl/rds-global-bundle.pem
ENV DATABASE_SSL_CA=/etc/ssl/rds-global-bundle.pem


WORKDIR /app

# Production deps only — tsx and esbuild (with Go CVE binaries) are devDeps,
# so they are absent here. This is the key CVE fix.
COPY --from=prod-deps /app/node_modules ./node_modules

# Pre-compiled JS (dist/db/) from the builder stage.
# Raw SQL migrations go into dist/db/migrations — matches __dirname in compiled migrate.js.
COPY --from=builder /app/dist/db ./dist/db
COPY --from=builder /app/db/migrations ./dist/db/migrations
# The identity v8 backfill/rollback SQL sits next to the compiled runner (run.js reads it from __dirname). It must be IN THE IMAGE
# BEFORE the identity v8 cutover change deploys, because the backfill (dry run, then --commit) has to run first: with empty v8 tables
# every existing user's sign-in is refused. Run it with: node dist/db/identity-v8/cli.js backfill --tenant-id ... --staff-domains ...
# (docs/runbooks/identity-v8-cutover.md).
COPY --from=builder /app/db/identity-v8/*.sql ./dist/db/identity-v8/
COPY --from=builder /app/package.json ./

RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 migrator \
    && chown -R migrator:nodejs /app

USER migrator

ENTRYPOINT ["/sbin/tini", "--"]
# Plain node runs pre-compiled JS — no tsx, no esbuild, no Go binaries.
CMD ["node", "dist/db/migrate.js"]

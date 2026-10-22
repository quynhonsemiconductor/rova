-- ============================================================
-- rova — Postgres container init script
-- Runs at container init (docker-entrypoint-initdb.d) via the
-- postgres superuser BEFORE any application connections.
--
-- Schemas (identity, tenancy, access, work, messaging,
-- notifications, audit) are intentionally NOT created here —
-- Drizzle migrations own the full DDL lifecycle including
-- CREATE SCHEMA statements. Running them here would cause
-- Drizzle's first migration to fail on already-existing schemas.
-- ============================================================

-- pgcrypto is built-in on PG 13+; included for completeness
-- and in case older extensions require it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migration: 0017_tenant_members
-- Adds tenancy.tenant_members — the "keycard" table for the real-Rally identity
-- model. A global user (identity.users) is ATTACHED to one or many tenants via
-- these rows, replacing the old users.tenant_id 1:1 ownership. This is the
-- additive first phase: the table is created and backfilled from existing
-- users.tenant_id, but no application code reads it yet (no behaviour change).

CREATE TABLE IF NOT EXISTS "tenancy"."tenant_members" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"      uuid NOT NULL,
  "user_id"        uuid NOT NULL,
  "role_id"        uuid,
  "status"         "workspace_member_status" NOT NULL DEFAULT 'active',
  "last_active_at" timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_member"
  ON "tenancy"."tenant_members" ("tenant_id", "user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_tenant_members_tenant"
  ON "tenancy"."tenant_members" ("tenant_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_tenant_members_user"
  ON "tenancy"."tenant_members" ("user_id");
--> statement-breakpoint

-- Backfill: every existing (non-deleted) user gets exactly one keycard for the
-- tenant they currently belong to. Idempotent — safe to re-run.
INSERT INTO "tenancy"."tenant_members" ("id", "tenant_id", "user_id", "status", "created_at", "updated_at")
SELECT gen_random_uuid(), u."tenant_id", u."id", 'active', now(), now()
FROM "identity"."users" u
WHERE u."deleted_at" IS NULL
ON CONFLICT ("tenant_id", "user_id") DO NOTHING;

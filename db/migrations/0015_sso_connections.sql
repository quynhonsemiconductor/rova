-- Migration: 0015_sso_connections
-- Adds identity.sso_connections — the per-tenant SSO/IdP registry that maps an
-- external identity provider (Entra `tid`, or SAML/OIDC issuer) to exactly one
-- Rally tenant. This is the authoritative, enterprise-grade mechanism for
-- resolving which tenant a federated user belongs to during SSO login.

DO $$ BEGIN
  CREATE TYPE "public"."sso_provider" AS ENUM ('entra', 'saml', 'google', 'okta');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."sso_connection_status" AS ENUM ('active', 'disabled');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "identity"."sso_connections" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"            uuid NOT NULL,
  "workspace_id"         uuid NOT NULL,
  "provider"             "public"."sso_provider" NOT NULL DEFAULT 'entra',
  "external_tenant_id"   varchar(255) NOT NULL,
  "issuer"               varchar(512),
  "default_role_slug"    varchar(64) NOT NULL DEFAULT 'project_member',
  "allowed_email_domains" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "jit_enabled"          boolean NOT NULL DEFAULT true,
  "status"               "public"."sso_connection_status" NOT NULL DEFAULT 'active',
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sso_connections_provider_external"
  ON "identity"."sso_connections" ("provider", "external_tenant_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_sso_connections_tenant"
  ON "identity"."sso_connections" ("tenant_id");

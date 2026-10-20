-- Migration: 0014_sso_identities
-- Adds identity.sso_identities table to support Microsoft Entra ID SSO (OIDC).
-- Each row links one external provider identity (provider + providerSub) to one
-- Rally user. The unique constraint on (provider, provider_sub) means a single
-- Entra OID can only map to one Rally user across all tenants.

CREATE TABLE IF NOT EXISTS "identity"."sso_identities" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"      uuid NOT NULL,
  "user_id"        uuid NOT NULL,
  "provider"       varchar(32) NOT NULL,
  "provider_sub"   varchar(255) NOT NULL,
  "provider_email" varchar(320) NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sso_identities_provider_sub"
  ON "identity"."sso_identities" ("provider", "provider_sub");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_sso_identities_user"
  ON "identity"."sso_identities" ("user_id");

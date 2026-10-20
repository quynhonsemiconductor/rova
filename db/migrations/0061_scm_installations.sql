-- 0061: SCM installations — bind a GitHub App installation to a workspace.
--
-- Org-level auto-discovery: an admin connects a GitHub App installation to a
-- workspace; Rally then auto-registers that installation's repos and resolves
-- inbound installation/installation_repositories webhooks to the workspace — no
-- per-repo typing. installation_id is GitHub's numeric id stored as text.

-- Ensure the provider enum exists in public. Fresh DBs already have it from 0058;
-- environments that applied a pre-pgEnum-refactor 0058 (which created it elsewhere)
-- do not, so create it here idempotently rather than assume public.scm_provider.
DO $$ BEGIN
  CREATE TYPE "public"."scm_provider" AS ENUM('github', 'ghe');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scm"."installations" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"    uuid NOT NULL,
  "provider"        "public"."scm_provider" NOT NULL DEFAULT 'github',
  "installation_id" varchar(64) NOT NULL,
  "account_login"   varchar(255),
  "account_type"    varchar(32),
  "active"          boolean NOT NULL DEFAULT true,
  "created_by"      uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scm_installations_installation"
  ON "scm"."installations" USING btree ("provider", "installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_scm_installations_workspace"
  ON "scm"."installations" USING btree ("workspace_id");

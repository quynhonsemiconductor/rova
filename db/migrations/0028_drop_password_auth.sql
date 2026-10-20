-- ============================================================================
-- Migration 0028: Drop password-based authentication
-- ============================================================================
-- Rally is now SSO-only (Microsoft Entra ID), matching OpsHub. Email/password
-- login, self-serve signup, and the forgot/reset-password flow have all been
-- removed from the application. This migration drops the now-unused persistence:
--
--   1. identity.password_reset_tokens — backed the forgot/reset-password flow.
--   2. identity.users.password_hash   — the only password column; SSO users
--                                        never had one (it was already nullable).
--
-- Authentication is handled entirely by Entra ID via SSO identities
-- (identity.sso_identities) and SSO connections (identity.sso_connections).
-- Password / MFA management lives in the user's Microsoft account.
-- ============================================================================

DROP TABLE IF EXISTS "identity"."password_reset_tokens";
--> statement-breakpoint
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "password_hash";

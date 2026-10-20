-- Migration: 0020_auth_session_sso_provider
-- Adds sso_provider to identity.auth_sessions so the refresh endpoint can
-- re-derive authMethod ('password' | 'sso') without decoding the old JWT.
-- Null = password session. 'entra' = Microsoft Entra ID SSO session.
-- This enables enterprise SSO refresh: the frontend re-validates with Entra
-- on every proactive refresh cycle instead of using Rally-only token rotation.

ALTER TABLE identity.auth_sessions
  ADD COLUMN sso_provider VARCHAR(32) NULL;

COMMENT ON COLUMN identity.auth_sessions.sso_provider IS
  'SSO provider identifier (e.g. ''entra'') for sessions created via SSO login. NULL for password sessions.';

-- Machine credentials. CI, scripts and the agent platform need to call the API without a browser
-- session, and today the only way in is a user's access token: 15-minute lifetime, minted by a login
-- flow, tied to a human's active session. Nothing unattended can use that, so integrations end up
-- driven by someone's personal session cookie — which is exactly the arrangement API keys exist to
-- replace.
--
-- SHAPE, AND WHY IT IS NOT REAL RALLY'S. Broadcom Rally mints an API Key in My Settings, sends it in
-- `zsessionid`, inherits the creating user's permissions, and NEVER EXPIRES. The first two are right
-- and are kept. The last two are the 2010 model, and both GitHub and Atlassian have since moved off
-- it: GitHub's fine-grained tokens carry per-resource permissions and a mandatory expiry, Atlassian
-- capped API tokens at one year. So this table keeps Rally's ergonomics and adds the three things its
-- model cannot express:
--   * `expires_at` is NOT NULL. A credential with no expiry is a credential nobody ever rotates.
--   * `scopes` NARROWS the principal's permissions (see below).
--   * `last_used_at` + `revoked_at` make "is this still in use, and by what" answerable, which is the
--     question that decides whether a leaked token can be revoked safely.
--
-- WHY sha256 AND NOT bcrypt/argon2. The secret is 32 bytes of CSPRNG output rendered base64url — ~256
-- bits of entropy, so there is no dictionary and no plausible brute force for a work factor to slow.
-- What a work factor WOULD do is run on every authenticated request, because this hash is the
-- authentication step. Password hashes are slow to defend LOW-entropy secrets; applying that here buys
-- nothing and costs a per-request CPU budget. GitHub and Stripe both store a fast hash of a
-- high-entropy token for the same reason. `token_hash` is unique so a duplicate mint is impossible
-- rather than merely unlikely.
--
-- WHY A PREFIX COLUMN. Authentication looks up by `prefix` and then compares hashes in constant time,
-- so the lookup is a single index probe rather than a scan. It also makes a token identifiable
-- WITHOUT holding it: the token list, the audit rows and a secret-scanner hit can all name
-- `rly_a1b2c3d4` without anything in the system being able to reconstruct the credential. The `rly_`
-- literal is what lets the auth guard tell an opaque token from a JWT before it tries to verify either.
--
-- `scopes` DOES NOT CONTRADICT "permissions are NEVER in the token". Authorization still resolves from
-- the database on every request — `PolicyGuard` reads the principal's assignments as it always has —
-- and this array is INTERSECTED with that result. An empty or absent array means no narrowing. The
-- direction is one-way by construction: a token can only ever hold a subset of what the user behind it
-- holds, so a grant revoked in the database takes effect on the token's next request, and a token can
-- never be a privilege-escalation path. That was the failure of the old `claims.permissions` snapshot
-- and it is not reintroduced here.
--
-- SECURITY ASSESSMENT, stated rather than implied.
--   - This is a long-lived bearer credential, which is a real widening: an access token dies in 15
--     minutes, one of these lives up to a year. Mitigations, in the order that matters: mandatory
--     expiry, scope narrowing, per-token revocation, `last_used_at` for detection, and the routes that
--     mint or revoke tokens REFUSE a request that is itself authenticated by a token — a leaked token
--     cannot mint a fresh one or extend its own life.
--   - Tokens die with their owner. Deactivating a user must revoke their tokens, exactly as it already
--     revokes their sessions; the user-level denylist covers the window before that write lands.
--   - The plaintext exists in exactly one place for one moment: the mint response. It is never logged
--     (the log redactor drops `token`), never stored, and cannot be re-read — a lost token is reset,
--     not recovered, which is also real Rally's behaviour.
CREATE TABLE IF NOT EXISTS identity.api_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  user_id       UUID NOT NULL,
  name          VARCHAR(100) NOT NULL,
  prefix        VARCHAR(16) NOT NULL,
  token_hash    TEXT NOT NULL,
  scopes        TEXT[],
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_tokens_prefix ON identity.api_tokens (prefix);
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_tokens_token_hash ON identity.api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_api_tokens_user ON identity.api_tokens (user_id);
CREATE INDEX IF NOT EXISTS ix_api_tokens_workspace ON identity.api_tokens (workspace_id);

COMMENT ON TABLE identity.api_tokens IS
  'Long-lived machine credentials (CI, scripts, agents). Plaintext is never stored: token_hash is '
  'sha256 of the secret, prefix identifies a token without holding it. See migration 0125.';

COMMENT ON COLUMN identity.api_tokens.scopes IS
  'NARROWING only — effective permissions are the user''s database assignments INTERSECTED with this '
  'array. NULL or empty means no narrowing. A token can therefore never exceed its owner.';

COMMENT ON COLUMN identity.api_tokens.last_used_at IS
  'Touched on use, throttled to once a minute: a write on every request would make authentication a '
  'write path. Its purpose is answering "is this token still in use" before revoking it.';

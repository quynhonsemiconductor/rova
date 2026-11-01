# PLATFORM_ADMIN_EMAILS: what the roster does, and what it does not

One `kv-qnsc-<env>` secret (API only) holding a comma-separated list of staff addresses. It exists so a
fresh deployment has an administrator before anyone can be granted the role in the app.

## The rule the code actually implements

`StaffSignInHandler` (`libs/modules/identity/src/infrastructure/auth/staff-sign-in.handler.ts:117-130`)
reads the roster on **every successful staff sign-in** and, if the address is on it, calls
`AccessService.elevateToWorkspaceAdmin`:

- **It re-grants, every time.** The grant is idempotent but unconditional: an address on the roster is
  workspace admin after every sign-in, whatever happened in between.
- **It does not revoke.** Removing an address from the roster stops future elevation; it does not
  demote anyone.
- **It overwrites a demotion.** An admin demoted in the app who is still on the roster is admin again
  at their next sign-in. This is deliberate: the roster is the break-glass path back to an
  administrator when every other one is gone, and it is the reason the list must stay short.
- Each elevation writes one `access.role_elevated` audit row (`via: PLATFORM_ADMIN_EMAILS,
method: sso`), so who was re-elevated and when is answerable from the audit log.

## Decision (2026-11-01, pre-prod security review)

**Documented, not restricted to first sign-in.** Grant-on-first-sign-in would leave a demoted admin
who belongs on the break-glass list stuck without admin until someone changes the roster — the exact
situation the roster exists for. The re-grant is the safer failure mode for a roster of one to three
addresses.

Consequences an operator must know:

1. Anyone on the roster is an administrator for as long as their address is on it, by design.
2. **To actually demote an administrator who is on the roster, remove the address from the roster
   secret first.** A demotion without that step reverts at the next sign-in.
3. The roster is API-only (`PLATFORM_ADMIN_EMAILS` is not injected into the worker); rotating it is a
   Key Vault write, `rova-prod-platform-admin-emails`, then a rolling restart of the API.
4. The API refuses to boot in production with the key empty
   (`apps/api/src/bootstrap/platform-admin-emails.ts:14`) — a production task must always name at least
   one administrator.

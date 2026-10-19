# Alert: auth-login-failure-rate

Ratio of failed to total login attempts (`auth_login_total`, `outcome="failure"`)
over 15 minutes has crossed the environment's threshold (15% prod / 30% develop)
for 15 minutes straight.

## What this means

A meaningful share of login attempts through identity's Microsoft callback
(`/api/auth/callback/microsoft`) are failing (`sign_in.failure` events, counted
into `auth_login_total` by the identity module's event sink). The 15-minute window (longer than
the other rules' 5m) is deliberate — login volume is naturally low, and a
shorter window would be noisy with few samples.

## Why this alert exists, specifically

identity's callback ends a refused or failed sign-in with a redirect to the login
page carrying a stable `?error=<CODE>` (never IdP or internal detail). A redirect
is a 302, so the HTTP error-rate panel/alert **cannot** see it, and "302" alone
doesn't say WHY. `auth_login_total` is the only
signal that distinguishes "login is broken" from "normal traffic."

## First checks

1. Overview dashboard, "Login success vs failure rate" panel — confirm the
   shape (a step change at a deploy vs a gradual climb vs a sudden spike).
2. Logs Explorer / Recent errors, filtered to `rova-api` — the reason is logged
   server-side as a structured line: `identity.staff_sign_in_refused` (the
   product hook refused: no profile/invitation, id mismatch), `identity.auth_handler_threw`
   or `identity.auth_server_error` (a 5xx), `security event: sign_in.failure`.
3. Check the Deploys annotation — did this start right after a deploy?
4. Check Entra/Azure AD's own service health and the app registration's client
   secret expiry — an expired secret fails EVERY login, not a subset.

## Likely causes, roughly in order

- Expired or rotated Entra client secret (`ENTRA_CLIENT_SECRET`)
- Entra tenant/app registration misconfiguration (redirect URI mismatch,
  consent revoked)
- Bad deploy to the identity module, or a missing/rotated `BETTER_AUTH_SECRET`
  (everyone is signed out, and a missing one stops the API from starting)
- State/PKCE cookie issues (identity's `__Secure-rova.state`) — e.g. a CDN/proxy
  change stripping cookies, a Pages Function not forwarding `/api/auth/*`, or
  `sameSite`/`secure` misconfiguration
- A genuine wave of user error (stale bookmarked links, expired sessions) —
  distinguishable from the above by NOT correlating with a deploy or config
  change

## Escalate if

The failure rate keeps climbing with no obvious cause, or nobody can log in at
all — that combination means the SSO integration itself is down, not a subset
of users hitting an edge case.

# Alert: auth-login-failure-rate

Ratio of failed to total login attempts (`auth_login_total`, `outcome="failure"`)
over 15 minutes has crossed the environment's threshold (15% prod / 30% develop)
for 15 minutes straight.

## What this means

A meaningful share of login attempts through `/bff/callback` (SSO) or
`/bff/dev-login` (dev/E2E only) are failing. The 15-minute window (longer than
the other rules' 5m) is deliberate — login volume is naturally low, and a
shorter window would be noisy with few samples.

## Why this alert exists, specifically

`BffController.callback` deliberately collapses every failure into one generic
`401 AUTH_TOKEN_INVALID` — it never surfaces OIDC/internal detail to the
browser, on purpose (never leak IdP error detail to an unauthenticated client).
That means the HTTP error-rate panel/alert **cannot** see this: a 401 on a login
route doesn't count toward `http_server_errors_total` the same way a 5xx does,
and even if it did, "401" alone doesn't say WHY. `auth_login_total` is the only
signal that distinguishes "login is broken" from "normal traffic."

## First checks

1. Overview dashboard, "Login success vs failure rate" panel — confirm the
   shape (a step change at a deploy vs a gradual climb vs a sudden spike).
2. Logs Explorer / Recent errors, filtered to `rova-api` — the actual OIDC
   exception is logged server-side even though the browser never sees it
   (`completeLogin` catch block logs before re-throwing as the generic 401).
3. Check the Deploys annotation — did this start right after a deploy?
4. Check Entra/Azure AD's own service health and the app registration's client
   secret expiry — an expired secret fails EVERY login, not a subset.

## Likely causes, roughly in order

- Expired or rotated Entra client secret (`ENTRA_CLIENT_SECRET`)
- Entra tenant/app registration misconfiguration (redirect URI mismatch,
  consent revoked)
- Bad deploy to the identity module
- State/PKCE cookie issues (`BFF_STATE_COOKIE`) — e.g. a CDN/proxy change
  stripping cookies, or `sameSite`/`secure` misconfiguration
- A genuine wave of user error (stale bookmarked links, expired sessions) —
  distinguishable from the above by NOT correlating with a deploy or config
  change

## Escalate if

The failure rate keeps climbing with no obvious cause, or nobody can log in at
all — that combination means the SSO integration itself is down, not a subset
of users hitting an edge case.

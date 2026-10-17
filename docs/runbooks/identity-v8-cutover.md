# identity v8: the cutover, and the way back

rova signs people in with `@quynhonsemiconductor/identity` 8 (Better Auth, the `staff` preset, Microsoft Entra, B2B guests for vendors)
instead of the v7 BFF session. This page is the operator's half: what to prepare, the order of the cutover on **develop** and then
**production**, how to prove it worked, and how to undo it. The data half (the tables, the backfill) is
[identity-v8-data-model.md](identity-v8-data-model.md).

**This change does not touch a v7 table.** The v7 tables (`identity.auth_sessions`, `sso_identities`, `sso_connections`, ...) are frozen at
day 7 and dropped at day 30, in two later changes. Until then rollback is a redeploy.

## What changes for people

- Sign-in is `POST /api/auth/sign-in/social` -> Microsoft -> `/api/auth/callback/microsoft`, same-origin with the SPA (a second Pages Function,
  `apps/web/functions/api/auth/[[path]].ts`). The cookie is `__Secure-rova.session_token` (it was `__Host-rova_session`).
- **Everyone signs in once.** v7 sessions are not migrated.
- The workspace switch is `POST /v1/auth/switch-workspace`; "who am I" is `GET /v1/auth/me` (both replace `/v1/bff/*`).
- API tokens (`rly_...`) keep working unchanged: the table is untouched and the credential is the same. A **banned** user's token is refused.
- A vendor signs in as a **B2B guest** of the company tenant. They are admitted only with a profile or a live invitation (by address or directory
  object); a guest is never created by just-in-time provisioning. Staff addresses follow `SSO_JIT_ENABLED` (invite-only in every deployed
  environment).

## What you prepare (once per environment)

| #   | Who   | What                                                                                                                                                                                                              | Proof                                                                                |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | owner | Entra app registration (the **sign-in** app, single-tenant): add the redirect URI `https://<app domain>/api/auth/callback/microsoft`. **Keep** the v7 one (`/v1/bff/callback`) until the day-7 change.           | the app's Authentication blade lists both                                            |
| 2   | owner | The registration emits the `email` and `upn` claims in the ID token (optional claims). The `staff` preset checks the address AND the UPN against `SSO_ALLOWED_EMAIL_DOMAINS`.                                      | `Sign-in logs` show a successful token with both; a test sign-in succeeds on develop |
| 3   | owner | `openssl rand -base64 48` -> the `better-auth-secret` key of `rova/<env>/app` (Secrets Manager). **Before** the image that needs it is deployed.                                                                  | `aws secretsmanager get-secret-value` shows the key (do not print it)                |
| 4   | owner | Set `better_auth_secret_set = true` in `infra/live/<env>/main.tf` and apply. develop's is already `true` in this change: **populate step 3 before merging.** Production stays `false` until its window.         | `tofu plan` shows the API task gaining `BETTER_AUTH_SECRET`, nothing else            |
| 5   | owner | Cloudflare Pages: `API_ORIGIN` and `EDGE_CLIENT_IP_SECRET` are already set for `/v1/*`; the new `/api/auth/*` Function reuses both.                                                                                | the web deploy lists `functions/api/auth`                                            |
| 6   | agent | The packages: `@quynhonsemiconductor/identity` >= 8.4.0 is in the registry (it is).                                                                                                                                | `pnpm install --frozen-lockfile` passes in CI                                        |

The worker is **not** given `BETTER_AUTH_SECRET`. Until PR 4 (below) the worker's Graph guest invite still uses `ENTRA_CLIENT_SECRET`.

## The cutover, in order (develop first, then production)

Everything before step 4 is additive and can be done any time before; steps 4-6 are the window. On production the window is off-peak
(Friday evening or Saturday morning, the owner picks the slot) and starts only after develop's **day-7 checkpoint**.

1. **Dry run of the backfill.** It does everything, checks everything, then rolls back. From the migrator image (the runbook does not need a
   laptop with database access):

   ```bash
   # one-off task with the migrator image and the migration role's connection (the same task definition as db:migrate)
   node dist/db/identity-v8/cli.js backfill --tenant-id <ENTRA_TENANT_ID> --staff-domains qnsc.vn
   ```

   It prints the counts it would write and either `DRY RUN: every preflight check and assertion passed` or a `RAISE` naming ids and counts (never
   addresses). Every raise is a decision for the owner, not a retry: more than one Entra identity per user, a live user that is neither an Entra
   user nor a staff address, an `sso_connections` row beyond the home directory connection and the `shared` guest gate (partner SSO is deferred),
   two users sharing a lower-cased address. Fix the data in v7, then dry-run again.

2. **Commit the backfill** (additive: it reads v7 and writes only `identity."user"` and `identity.account`):

   ```bash
   node dist/db/identity-v8/cli.js backfill --tenant-id <ENTRA_TENANT_ID> --staff-domains qnsc.vn --commit --database <database name>
   ```

   `--commit` refuses unless `--database` names the database the connection is on. It is idempotent and re-runnable: a re-run carries renames,
   avatars and suspensions, and bans (never deletes) a user deleted in v7 since.

3. **Check the invariant** (both queries must return no rows): the one in identity-v8-data-model.md, "`identity.users` stays".

4. **Deploy** the API, the worker and the web together (the usual pipeline). On develop that is the merge of this change. The API starts only
   if `BETTER_AUTH_SECRET` is present (step 3-4 above): a missing secret is a crash-looping API task, not a silent downgrade, and the previous
   task keeps serving until the new one is healthy.

5. **Re-run the backfill** once the deploy has settled (idempotent): it picks up anyone v7 created while the rolling deploy overlapped. Those
   people would sign in again anyway; this keeps the id invariant true for them.

6. **Verify** (develop: you; production: you and one other person), in a private window:

   - [ ] Staff sign-in lands in the home workspace; `GET /v1/auth/me` returns the same `id` as before the cutover for that person (the profile id did not change).
   - [ ] A workspace switch works for a member of two workspaces and is refused (403) for a workspace they are not in. Removing the member takes the workspace away on their open session within a second.
   - [ ] A vendor with a live invitation signs in as a guest and sees only what their invitation granted; a guest with none gets `?error=STAFF_SIGN_IN_REFUSED` on the login page.
   - [ ] An API token minted before the cutover authenticates; revoking it returns 401. Disabling the owner (a banned `identity."user"`) returns 401 for the token too.
   - [ ] A user suspended/removed from the workspace cannot reach it (zero permissions), and their API tokens are revoked (unchanged behaviour).
   - [ ] Sign out, and "sign out everywhere" (`POST /v1/auth/logout-all`), end the session.
   - [ ] No `identity.profile_id_mismatch`, `identity.staff_sign_in_refused` (other than the refusals you caused), `identity.auth_handler_threw` or `identity.context_cache_stale` log line. `identity.sign_in.failure` is a metric; the `rate_limit` fail-open alarm stays quiet.

## Rollback (day 0 to day 7)

Before the day-7 freeze nothing in the database has to be undone: **redeploy the previous image** (API, worker) and the previous Pages deployment.
The v7 tables, the profile table, workspace membership, roles and API tokens are shared, so:

- people sign in again (v8 sessions mean nothing to v7, and the reverse), and they are provisioned by v7's sign-in as before;
- anyone created in v8 has a profile row (`identity.users`), which v7's sign-in links by address;
- the Terraform keeps `JWT_PRIVATE_KEY` and `ENTRA_REDIRECT_URI` bound to the tasks for exactly this: the v7 image needs both to boot. They go in
  the day-7 change, not before.

Do **not** run `db:identity-v8:rollback` as part of this rollback: the v8 tables are inert for the v7 image and hold the bans. It exists to undo
migration 0136 on a database where nothing has been written, and it refuses once a later migration is recorded (roll forward with a DROP migration).

A fix-forward is usually better than a rollback for a problem in the product hook (`StaffSignInHandler`): its refusals are visible, per person,
and carry a code.

## Day 7 and day 30 (separate changes, not this one)

- **Day 7, freeze:** stop writing v7 (revoke `INSERT/UPDATE/DELETE` on the v7 identity tables from the app role), remove `JWT_PRIVATE_KEY`,
  `JWT_*` and `ENTRA_REDIRECT_URI` from the task definitions, and remove the v7 redirect URI from the Entra app. The seed's v7 SSO
  connection writes (`db/seeds/bootstrap.ts`) stop at the same time; the sign-in hook already reads the home workspace from `HOME_WORKSPACE_ID`
  and the domains and the JIT flag from the environment, not from `sso_connections`.
- **Day 30, drop:** `DROP` the v7 tables (`auth_sessions`, `sso_identities`, `sso_connections`, `sso_connection_domains`) in a migration, and
  delete the backfill's inputs from the docs.

## Not in this change (PR 4)

`User.Invite.All` (the Graph application permission the worker uses to invite a vendor as a B2B guest) is still on the **sign-in** app, and the
worker still authenticates to Graph with `ENTRA_CLIENT_SECRET`. The plan moves it to the "Rova <Env> Service" app with a certificate (worker only),
which is rova#715 (the code) and rova#716 (the infra: the standalone secret `rova/<env>/mail-graph-certificate`). It is a separate change on
purpose: it is a different app registration, a different credential and a different consent, and it must not ride on a sign-in cutover. When it
lands the sign-in app is delegated-only.

## Operating notes

- Rotating `BETTER_AUTH_SECRET` signs everyone out (and nothing else). `COOKIE_SECRET` and `CSRF_SECRET` are separate and unaffected.
- A session lasts 12 hours (the `staff` preset); there is no refresh. Signing in again is one redirect.
- Offboarding someone from the workspace is unchanged (members -> suspend/remove). To disable a person everywhere, ban their identity user
  (`setUserBanned`, service side): it ends every session and refuses sign-in and API tokens at once. There is no admin screen for it yet.
- The identity package's own checks run in CI as `test/e2e/identity-conformance.e2e.spec.ts` (against a PostgreSQL 18 service until the kit runs on 17).

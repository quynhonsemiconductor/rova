# rova production release night: the checklist

Owner-facing. Two nights, in this order, each with its own go/no-go. The detailed procedure for each
lives in its own runbook; this file is the ORDER, the NAMES and the gates, so the window does not
depend on anyone re-reading three documents at 22:00.

Decided 2026-10-30: **identity 8 ships on AWS production first, on its own night**, so the on-prem move
night changes only the infrastructure. Mail moves to Microsoft Graph after that (with the on-prem move,
where the certificate comes from Key Vault), and the SES removals trail it.

- Night 1 — identity 8 (this file, section 1). Deep reference: `docs/runbooks/identity-v8-cutover.md`,
  "Production".
- Night 2 — the on-prem cutover, with Graph mail inside it. Deep references: the data-move runbook and
  `docs/runbooks/mail-graph.md`, section 9.

Nothing here is a command to copy: the owner script `scripts/owner/identity-v8-cutover.sh prod` performs
the credentialed steps one at a time, asking before each write.

## 0. Before either night

| #   | Gate                                                                                    | Why                                                                    |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0.1 | The previous night's smoke tests passed and no release tag was cut in between           | one change per night; a tag in between re-runs the on-deploy preflight |
| 0.2 | A manual RDS snapshot of `rova-prod` exists, id recorded where the session log keeps it | the only data restore point                                            |
| 0.3 | CI is paused for the window: no release tag is merged while the window is open          | a tag deploys to ECS and runs the migrator                             |
| 0.4 | The release-please PR is reviewed and waiting for the owner's "go release"              | the tag is the deploy                                                  |

## 1. Night 1 — identity 8 on AWS production

### Secrets and environment the owner writes (names only)

| Where                                      | Name                                                                                             | Notes                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| AWS Secrets Manager, `rova/production/app` | `better-auth-secret`                                                                             | 32+ random bytes, written once; the API cannot start without it                      |
| AWS Secrets Manager, `rova/production/app` | `edge-client-ip-secret`                                                                          | one value, shared with the Pages secret below                                        |
| Cloudflare Pages project `rova-prod-web`   | `EDGE_CLIENT_IP_SECRET`                                                                          | the same value; the Pages Function answers 500 for every `/v1/*` without it          |
| `infra/live/prod/main.tf`                  | `better_auth_secret_set`, `edge_client_ip_secret_set`, `identity_v8_backfill_on_deploy`          | all three `true` in the cutover change (rova#735), merged and applied BEFORE the tag |
| Entra sign-in app "Rova Prod"              | redirect URI `https://rova.qnsc.vn/api/auth/callback/microsoft`, optional claims `email` + `upn` | the script sets these                                                                |

### Order

1. `bash scripts/owner/identity-v8-cutover.sh prod` — retention check, `better-auth-secret`, the redirect
   URI and claims, the edge secret, then the manual snapshot. It stops on a failure and nothing is live yet.
2. Merge rova#735 (the three flags). The owner runs the prod `Infrastructure · Apply` and reviews the plan:
   the API task gains the two secrets, the migrator task gains `IDENTITY_V8_BACKFILL=commit`, nothing else.
3. Announce the downtime (Teams).
4. **"Go release"** — the SA merges the release-please PR; the tag runs the migrator (backfill committed,
   a RAISE stops the deploy and the v7 tasks keep serving), then rolls the API; the web deploy waits for it.
5. Verify, in this order: `/readyz` green; sign in from a private window (a new `__Host-rova.session_token`
   cookie); `/api/auth/callback/microsoft` accepted; the API and worker logs carry the v8 tables and no
   `relation ... does not exist`; a guest invitation still works.
6. The change after the night sets `identity_v8_backfill_on_deploy` back to `false` and applies. While it
   is `true`, every later deploy re-runs the preflight against live data.

### Smoke tests (Night 1)

- Sign in, sign out, sign in again; the session survives a reload.
- Create and edit a work item; the activity log names the v8 user row.
- Trigger one notification email (assignment) — it goes out through SES, unchanged on this night.
- `/readyz` reports database and cache green.
- A v7 rollback image is not needed to pass; see Rollback.

### Rollback (Night 1)

- **Before the tag is cut:** do nothing on the app. Revert the flags if you abort (`identity_v8_backfill_on_deploy`
  first) and apply.
- **After the tag, API unhealthy:** the circuit breaker rolls the API back to the previous task
  definition by itself; the v7 code does not read the v8 tables, so the data made so far is inert. Fix
  forward with a corrective tag.
- **Do not delete the new tables or run a down migration.** The cutover is additive by construction;
  undoing it is a separate decision with its own snapshot.
- The snapshot from step 1 is the data restore point if the migrator itself is at fault.

## 2. Night 2 — the on-prem move (summary; the data-move runbook owns the detail)

Graph mail rides here because the certificate comes from Key Vault, not Secrets Manager:

| Where                          | Name                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure Key Vault `kv-qnsc-prod` | `rova-prod-graph-cert` (combined PEM: private key + certificate)                                                                                                            |
| Entra "Rova Prod Service" app  | certificate credential (`infra/live/identity/mail.tf`, applied), admin consent for `User.Invite.All`                                                                        |
| Exchange                       | `Application Mail.Send`, scope `noreply-rova`, assigned to the **Service** app; the sign-in app's assignment removed after the proof                                        |
| gitops `values/rova/prod.yaml` | `EMAIL_PROVIDER=graph`, `MAIL_GRAPH_SENDER`, `MAIL_GRAPH_CLIENT_ID`, the cert secret mounted to the worker only, `AZURE_CLIENT_CERTIFICATE_PATH`, `REDIS_URL` as `redis://` |
| rova release                   | the image that rejects unreplaced placeholders (rova#727)                                                                                                                   |

The other prod Key Vault values follow the dev shape (`values/rova/dev.secrets.yaml`), generated fresh
rather than copied: `rova-prod-cookie-secret`, `rova-prod-csrf-secret`, `rova-prod-entra-client-secret`,
`rova-prod-better-auth-secret` (API only), `rova-prod-platform-admin-emails` (API only — required at boot
when `NODE_ENV=production`, `apps/api/src/bootstrap/platform-admin-emails.ts:14`), the R2 access key pair,
and the DB role passwords plus the CNPG CA. `REDIS_URL` is plain `redis://` on the in-cluster Valkey;
there is no ElastiCache TLS on-prem. No `SES_*`, `SQS_*` or CloudWatch value is set on this host.

The SES removals (rova#730, then infra#188) follow only after one real invitation from
`noreply-rova@qnsc.vn` has been delivered from the new host, and after every product is off SES.

## 3. What must never happen in a window

- A release tag cut while another night's change is half-applied.
- A secret written to a file, a shell history, a log or chat; values go in through stdin only.
- `identity_v8_backfill_on_deploy = true` committed without `better_auth_secret_set = true` in the same
  file — `test/identity-v8-deploy-guard.spec.ts` fails the PR on exactly that.
- A DNS or edge apply merged in the same commit as an application change; each is its own reviewed apply.

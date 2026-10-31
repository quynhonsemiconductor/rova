# Rova email through Microsoft 365 (Graph, certificate, one mailbox per environment)

Rova sends invitations and notifications through Microsoft Graph `sendMail` using the **Exchange Online RBAC for Applications**
role **Application Mail.Send**, authenticated by a **certificate**, from **one shared mailbox per environment**. This is the owner's setup guide
and the way to prove it. It is the same procedure, in the same order and with the same three-step check (TOKEN / SEND / DENIED), as
`qnsc-kb-backend/docs/runbooks/email-graph.md`, so one person runs one procedure for every product.

Plan: HYBRID-INFRA-PLAN §7.4 (all email through Graph, one mailbox and one app per product, no tenant-wide `Mail.Send`) and Appendix B item 11.

## The design, and why

| Choice                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two Entra apps per environment.** The **sign-in app** (`ENTRA_CLIENT_ID`: delegated, client secret, API only) and the **"Rova <Dev | Prod> Service" app** (`MAIL_GRAPH_CLIENT_ID`: **certificate only, no client secret, worker only**)                                                                                                                                                                                                                                                        | A compromised API process must not hold a credential that can send mail or call Graph. The Service app is the only one that holds application permissions, and the only one with the Exchange role |
| **The Exchange role is on the Service app**, never on the sign-in app                                                                | Separation of duties; revoking mail does not touch sign-in                                                                                                                                                                                                                                                                                                |
| **No Graph permission for mail in Entra. Not `Mail.Send`, not `Mail.ReadWrite`, no admin consent for mail**                          | Entra grants and Exchange RBAC grants are **additive** ([Microsoft: the grants are independent of Entra's](https://learn.microsoft.com/exchange/permissions-exo/application-rbac)). An Entra `Mail.Send` consent lets the app send as **any** mailbox and makes the Exchange scope meaningless. The app's only mail authority is the scoped Exchange role |
| **One management scope per mailbox**, filtered on `PrimarySmtpAddress`                                                               | A stolen key can send as that one mailbox and as nobody else                                                                                                                                                                                                                                                                                              |
| **A non-prod environment never sends from the prod mailbox** (decision 2026-10-18)                                                   | Develop has its own mailbox `noreply-rova-dev@qnsc.vn` scoped to the **develop** Service app; production uses `noreply-rova@qnsc.vn` scoped to the **production** Service app. Each has its own quota and sending reputation, and a develop mistake cannot send as production. Local stays on the console provider                                        |
| **A certificate, no client secret**                                                                                                  | A secret is a string anything that can read the environment can replay; the key lives only in Secrets Manager and the app proves possession by signing a short-lived assertion                                                                                                                                                                            |
| **Shared mailboxes**                                                                                                                 | No licence, no sign-in; the sender address needs to exist, not to be a person                                                                                                                                                                                                                                                                             |

Who can do what: **Exchange**: Organization Management (mailbox, scope, role assignment). **Entra**: Application Administrator or Cloud
Application Administrator (register the app, upload the certificate). **AWS**: write access to the secret `rova/<env>/mail-graph-certificate`. **No Global
Administrator consent is needed**, which is the point.

## Where things stand (what is missing)

|                                                            | develop                                                    | production                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox                                                    | `noreply-rova-dev@qnsc.vn` **missing: create it (step 1)** | `noreply-rova@qnsc.vn` exists (2026-10-11)                                                                                                      |
| Management scope                                           | missing (step 2)                                           | `noreply-rova` exists (2026-10-11)                                                                                                              |
| "Rova <Dev                                                 | Prod> Service" Entra app                                   | **missing: create it, certificate only** (step 3)                                                                                               | **missing: create it** (step 3) |
| Certificate and secret `rova/<env>/mail-graph-certificate` | missing (steps 4-5)                                        | missing (steps 4-5)                                                                                                                             |
| Exchange role assignment                                   | missing (step 6)                                           | exists, but on the **sign-in app** "Rova Prod" (`503133fe-58c0-4158-86ca-0cecb2f6f376`): **it moves to the Service app** (step 6, then step 10) |
| Switch-on PR                                               | not opened: needs the Service app's client id              | not opened: same                                                                                                                                |

The sign-in apps are `45fabceb-e51c-446b-894e-af4c4b7f30f8` (develop) and `503133fe-58c0-4158-86ca-0cecb2f6f376` (production). The author could not verify any of the
"missing" rows against the tenant (no access): they are what the plan, the repository and the 2026-10-11 record show, so **confirm each** as you go.

Repeat steps 3-9 for each environment. Steps 1-2 are per mailbox. **Do the develop environment first** and prove it before production.

## 1. The mailboxes

One shared mailbox per environment: `noreply-rova-dev@qnsc.vn` (develop) and `noreply-rova@qnsc.vn` (production).

```powershell
Connect-ExchangeOnline

# develop (new)
New-Mailbox -Shared -Name "Rova Dev No-Reply" -DisplayName "Rova (dev)" `
  -Alias noreply-rova-dev -PrimarySmtpAddress noreply-rova-dev@qnsc.vn
Set-Mailbox noreply-rova-dev@qnsc.vn -HiddenFromAddressListsEnabled $true   # optional

# production: `noreply-rova@qnsc.vn` already exists (created 2026-10-11): nothing to do.

Get-Mailbox noreply-rova-dev@qnsc.vn, noreply-rova@qnsc.vn | Format-List PrimarySmtpAddress, RecipientTypeDetails   # SharedMailbox
```

Mail flow for `qnsc.vn` is already Microsoft 365's, so SPF should include `spf.protection.outlook.com`; check `nslookup -type=txt qnsc.vn`
and that outbound DKIM for the domain is enabled in the Defender portal (Email & collaboration > Policies > Email authentication
settings > DKIM). The old SES DKIM records are unrelated and are owned by qnsc-infra's `edge` stack.

## 2. The management scope (one mailbox each)

```powershell
New-ManagementScope -Name "Rova mail develop" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noreply-rova-dev@qnsc.vn'"
# production: the scope "noreply-rova" already exists (2026-10-11); check it with Get-ManagementScope "noreply-rova"
```

## 3. The Entra "Rova <Dev|Prod> Service" app registration (per environment)

Entra admin center > App registrations > New registration: name `Rova Dev Service` / `Rova Prod Service`,
**single tenant**, no redirect URI. The sign-in apps (`45fabceb-…` develop, `503133fe-…` production) stay as they are. Then:

- **API permissions:** add **Microsoft Graph > Application > `User.Invite.All`** (the guest invite; admin consent required) and **nothing for mail**. Do not add Microsoft Graph `Mail.Send` (mail is authorised by the Exchange RBAC role, step above/below). Remove the default `User.Read` delegated entry (unused).
- Record three IDs: **Application (client) ID** and **Directory (tenant) ID** from the app's Overview, and the **Object ID of the enterprise
  application** (Enterprise applications > the app > Object ID). Do **not** use the Object ID on the _App registrations_ page; it is a different
  object and Exchange rejects it. If the enterprise application does not exist: `az ad sp create --id <client-id>`.
- **Do not create a client secret** on this app.

## 4. The certificate

On a trusted workstation (not a CI runner). Two years; put the renewal in the calendar. The key never leaves your terminal except into the
secret in step 5.

```bash
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 730 \
  -keyout mail.key -out mail.crt -subj "/CN=rova-service-<env>"
openssl x509 -in mail.crt -noout -enddate -fingerprint -sha256
```

- Upload **`mail.crt` only** to the app: Certificates & secrets > Certificates > Upload certificate.
- RSA only: the client assertion is RS256 and the library refuses an EC key.

## 5. The secret (do this BEFORE the switch-on PR)

The credential is its own Secrets Manager secret, `rova/develop/mail-graph-certificate` / `rova/production/mail-graph-certificate`, holding **one PEM: the private
key, then the certificate** (`cat mail.key mail.crt`). It is **not** a key of the app bundle `rova/<env>/app`: the bundle is readable by the API's task
role, and the API must not be able to read a credential that can send mail. Only the **worker's execution role** is granted this secret (it injects it at
start); no task role is. Terraform creates the empty container when the infra PR is applied (`aws secretsmanager describe-secret` finds it); you put the value:

```bash
set -o pipefail
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
cat mail.key mail.crt | aws secretsmanager put-secret-value \
  --secret-id rova/develop/mail-graph-certificate --secret-string file:///dev/stdin
# Verify WITHOUT printing the value: it starts with a PEM header and holds both blocks
aws secretsmanager get-secret-value --secret-id rova/develop/mail-graph-certificate --query SecretString --output text \
  | python3 -c 'import sys; v=sys.stdin.read(); print("starts:", v[:11], "| key block:", "PRIVATE KEY-----" in v, "| certificate block:", "BEGIN CERTIFICATE-----" in v, "|", len(v), "chars")'
```

Expected: `starts: -----BEGIN  | key block: True | certificate block: True`. The library also parses the PEM when the worker starts, so a malformed value fails
the deploy with an error naming `AZURE_CLIENT_CERTIFICATE_PATH`, never its content. The file holds ONE PEM, private key first, then the certificate (`cat mail.key mail.crt`).

Keep `mail.key` only until the verification in step 8 has passed, then delete it from the workstation; the secret is then its only copy. Keep
`mail.crt` and the expiry date.

## 6. Exchange RBAC for Applications (the only grant)

```powershell
Connect-ExchangeOnline
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Rova <Dev|Prod> Service"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" `
  -CustomResourceScope "Rova mail develop"      # production: the production scope

Get-ManagementRoleAssignment -RoleAssignee "Rova <Dev|Prod> Service" | Format-List Role, CustomResourceScope
# The scope's filter, exactly (production: PrimarySmtpAddress -eq 'noreply-rova@qnsc.vn'; develop: ... 'noreply-rova-dev@qnsc.vn'):
Get-ManagementScope "<the scope name above>" | Format-List Name, RecipientFilter
# In scope for its own mailbox, NOT for the other environment's, NOT for another product's:
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply-rova-dev@qnsc.vn   # InScope : True   (develop app)
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply-rova@qnsc.vn       # InScope : False  (develop app)
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply-opshub@qnsc.vn               # InScope : False
# and for the PRODUCTION app, the reverse of the first two lines:
#   -Resource noreply-rova@qnsc.vn  -> InScope : True      -Resource noreply-rova-dev@qnsc.vn  -> InScope : False
```

`Test-ServicePrincipalAuthorization` reads Exchange only and bypasses its permission cache; it **does not see Entra grants**. Real Graph calls
can lag a fresh assignment (Microsoft's guidance is up to roughly half an hour, and the first `New-ManagementRoleAssignment` in a tenant took
about an hour on 2026-10-11, see Appendix B item 11); if step 8 returns 403 on the _allowed_ mailbox straight after this, wait and retry before
debugging.

## 7. Make sure there is NO mail grant in Entra

Entra admin center > Enterprise applications > the Service app > Permissions: **empty** of Microsoft Graph application permissions (Rova's Service app has none).

```powershell
Connect-MgGraph -Scopes "Application.Read.All"
$sp = Get-MgServicePrincipal -Filter "appId eq '<client-id>'"
Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id | Select-Object AppRoleId, ResourceDisplayName
```

Check the **sign-in apps** the same way (`45fabceb-…` develop, `503133fe-…` production): once the Service app holds `User.Invite.All`, the sign-in apps must hold NO application permissions (no `User.Invite.All`, nothing under `Mail.*`).

If a Microsoft Graph `Mail.*` role is listed on any of them (especially `Mail.Send`), **remove it**. This is the step people skip, and it is what makes the 403
negative test fail in step 8.

## 8. Prove it, including the 403

With the Service app's own sender, from a workstation that holds `mail.crt` and `mail.key`, in a checkout of this repository after
`pnpm install` (the check ships in `@quynhonsemiconductor/platform-mail`):

```bash
# DEVELOP app: sends as the dev mailbox, must be REFUSED as the PROD mailbox
pnpm exec platform-mail-check \
  --tenant <tenant-id> --client-id <develop-service-app-client-id> --cert mail.crt --key mail.key \
  --sender noreply-rova-dev@qnsc.vn --to <your address> \
  --denied-mailbox noreply-rova@qnsc.vn --denied-mailbox noreply-opshub@qnsc.vn
```

Expected, in order:

```
PASS  TOKEN   issued for appid=<client-id>; roles in the token: none (expected when authority comes from Exchange RBAC only)
PASS  SEND    sent as noreply-rova-dev@qnsc.vn to <you> (HTTP 202)
PASS  DENIED  as noreply-rova@qnsc.vn: forbidden HTTP 403 (request-id ...)
PASS  DENIED  as noreply-opshub@qnsc.vn: forbidden HTTP 403 (request-id ...)
```

- `DENIED` is the **negative test** and the proof that the scope works. **For develop it must be the PRODUCTION mailbox that is refused.** Only
  a refusal with **403** passes. If it says the send was _accepted_, the app can send as anyone: go back to step 7.
- For production, the same with the production Service app, `--sender noreply-rova@qnsc.vn`, `--denied-mailbox noreply-rova-dev@qnsc.vn` (**the other environment's mailbox**) and `--denied-mailbox noreply-opshub@qnsc.vn`.
- `--denied-mailbox` is required and repeatable. `SCOPE` fails on **any** role in the token (this app has none), and the exit code is 3 when nothing failed but the scope could not be proven.
- If the token's `roles` lists `Mail.Send`, step 7 was not done (the check also prints a `FAIL SCOPE` line).
- `TOKEN` failing with `AADSTS700027` (invalid assertion signature) or `AADSTS700024`: the certificate uploaded to Entra is not the one whose key
  you hold. Nothing was sent.

## 9. Switch the environment on

1. The repository already names the mailbox for each environment (`mail_graph_sender` in `infra/live/<env>/main.tf`). Open a PR that sets, for the
   environment: `email_provider = "graph"`, `mail_graph_client_id = "<the Service app's client id>"` and `mail_graph_certificate_set = true`. The module fails the plan if the sender, the client id or the certificate flag is missing.
2. Merge it. `Infrastructure · Apply` registers the task definitions with the new variables; the **image must already contain the Graph provider**
   (the code PR is merged and deployed first: an older image rejects `EMAIL_PROVIDER=graph` at boot).
3. Deploy. The worker **refuses to start** with `EMAIL_PROVIDER=graph` if the sender, the app or the credential is missing, so a half-configured
   environment fails the deploy instead of quietly queueing mail.
4. Post-deploy, from inside the worker's own configuration (it proves the deployed task, not your workstation). Find the cluster and task
   definition first: `aws ecs list-clusters`, `aws ecs list-task-definitions --family-prefix rova-` (the worker's family).

   ```bash
   aws ecs run-task --cluster <cluster> --task-definition <worker-task-definition> --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-ids>],securityGroups=[<worker-sg>],assignPublicIp=DISABLED}" \
     --overrides '{"containerOverrides":[{"name":"<worker-container>","command":["sh","-c","MAIL_TRANSPORT=graph AZURE_TENANT_ID=$ENTRA_TENANT_ID AZURE_CLIENT_ID=$MAIL_GRAPH_CLIENT_ID AZURE_CLIENT_CERTIFICATE_PATH=/tmp/rova-graph-cert.pem MAIL_SMOKE_TO=<you>@qnsc.vn node node_modules/@quynhonsemiconductor/platform-mail/dist/smoke/cli.js"]}]}'
   ```

   Read the task's log: `platform-mail-smoke: OK transport=graph id=...`. Exit 4 is `forbidden` (the role assignment or scope is wrong).

5. End to end: invite a person to a workspace in the app, to an address you can read. The message arrives from the environment's mailbox.

## 10. Rova production only: take the role off the sign-in app

Rova production was scoped on 2026-10-11 **on the sign-in app** ("Rova Prod", `503133fe-58c0-4158-86ca-0cecb2f6f376`, scope `noreply-rova`): the app that holds
the BFF client secret and runs in the API. Mail belongs to the Service app (certificate only, worker only), so the assignment **moves**:

1. Create the production Service app and its assignment (steps 3-7) **first**, while the old assignment is still in place.
2. Pass step 8 with the Service app, then complete step 9 and see a real invitation arrive from `noreply-rova@qnsc.vn`.
3. **Only then** remove the old one:

   ```powershell
   # Find it by what it is (role + scope), not by the app's display name, which Exchange may show differently
   Get-ManagementRoleAssignment -Role "Application Mail.Send" | Where-Object { $_.CustomResourceScope -eq "noreply-rova" } |
     Format-List Name, RoleAssignee, CustomResourceScope
   # The ONE whose RoleAssignee is the SIGN-IN app (503133fe-…) is the old one; the Service app's has the same scope and must stay.
   Remove-ManagementRoleAssignment -Identity "<the assignment's Name from above>"
   Test-ServicePrincipalAuthorization -Identity 503133fe-58c0-4158-86ca-0cecb2f6f376 -Resource noreply-rova@qnsc.vn   # InScope : False (or Not Run)
   ```

   Leave the sign-in app's Exchange service-principal pointer if you like; with no assignment it grants nothing.

If step 2 fails, nothing was lost: the old assignment still lets the sign-in app send, and production is still on SES until step 9.

## When Graph refuses, or does not answer

The relay and the provider split the answers by **whose fault it is**:

- **A problem with the message** (400 invalid, 413 too large) is **not retried**: the row is **dead-lettered at once** (`email_outbox.status = 'failed'`,
  `last_error` carries the code, the status and Microsoft's request id, never a recipient or a body). The worker logs `outboxDeadLetter`, which the
  **`outbox-dead-letter` alarm** matches.
- **A problem with the SENDER** (403 forbidden or 404 on `sendMail`: the Exchange role assignment is missing or **still propagating, which takes up to
  about two hours**, or the mailbox is missing or not REST-enabled) is **not** the fault of any queued message, so nothing is dead-lettered for it.
  The provider **blocks the sender for 15 minutes**: this row and every row after it are **deferred** (their attempt is refunded) without calling
  Graph, and the worker logs one `senderBlocked` error per block. The **`email-sender-blocked` alarm** matches it, and stays in ALARM while the blocks
  continue. **That alarm is the signal that no email is leaving**; `outbox-dead-letter` stays silent. Fix the cause (steps 1, 2, 6, 7); the next
  attempt after the 15 minutes goes through, with nothing to re-queue.
- **A throttle** (429) honours Microsoft's `Retry-After` (the row is rescheduled for it); a 5xx or a timeout is retried by the relay with backoff,
  up to its five attempts, then dead-lettered. The provider is deliberately **not** behind the generic retry/circuit-breaker wrapper, so a refusal
  never opens a breaker for good mail and a throttle is not re-sent on top of the transport's own retries.
- After a _message_ problem is fixed, the failed rows are **not retried by themselves**. List them, then re-queue only the ones you want, once
  (the table has `seq` and `scheduled_at`, no `created_at` or `next_attempt_at`):

  ```sql
  SELECT id, "to", template, attempts, left(last_error, 120) FROM messaging.email_outbox
  WHERE status = 'failed' ORDER BY seq DESC LIMIT 50;

  UPDATE messaging.email_outbox SET status = 'pending', attempts = 0, scheduled_at = now(), last_error = NULL
  WHERE id IN (<the ids>);
  ```

## Rotation and revocation

- **Rotate (before the expiry date):** generate a new pair, upload the new certificate in Entra **next to** the old one, replace the secret (as in
  step 5), redeploy the worker, verify with step 8, then delete the old certificate in Entra.
- **Revoke now:** delete the certificate in Entra (new tokens stop at once; an issued token lives up to an hour). To cut the app off from the mailbox
  as well: `Remove-ManagementRoleAssignment` for its assignment.
- **The k3s move** (no certificate): add a **federated credential** to the same Service app (issuer `https://oidc.<domain>/onprem`, subject
  `system:serviceaccount:rova:worker`, audience `api://AzureADTokenExchange`), mount the projected token, set `MAIL_GRAPH_FEDERATED_TOKEN_FILE`, and delete the
  certificate. The federated token wins whenever it is set, so nothing else changes.

## Local development

`EMAIL_PROVIDER=dev` (the `.env.example` default) writes the message to the log and sends nothing. It is never `graph` locally.

## Follow-ups (not in this change)

- **The guest invite's `User.Invite.All` moves OFF the sign-in app.** Once the Service app has `User.Invite.All` (admin consent) and the worker reads
  `AZURE_CLIENT_CERTIFICATE_PATH`, the permission is REMOVED from the sign-in apps (they become delegated-only) and `ENTRA_GUEST_INVITE_ENABLED` is the
  only switch. `User.Invite.All` is tenant-wide; accepted because only the worker holds the Service certificate (ONPREM-PLAN §7.3).
- **Remove SES and Resend** (tracked: quynhonsemiconductor/rova#717) (the `ses`/`resend` providers, `SES_*` and `MAIL_FROM_*` variables, the `ses:SendEmail` grants, the SES configuration set, SNS topic and
  SQS bounce queue with their alarms) in one cleanup PR **after both environments are proven on Graph**: removing them earlier stops the API at boot, because the
  deployed task definitions still name `ses`. SES identity and DNS stay in infra/edge until all three products are off SES.
- **Bounce feedback is gone with SES.** Graph reports no bounce events; a non-delivery report arrives in the shared mailbox. `email_outbox.status = 'sent'`
  then means "accepted by Graph". Reading the mailbox for NDRs is a later decision (platform-mail lists bounce handling as a later ADR); until then someone
  who needs to know a mistyped address bounced reads the mailbox.
- **Volume.** Exchange limits are per mailbox (about 30 messages a minute, 2,000 external recipients a day from October 2026). The relay is not paced to
  Graph's limit; the transport honours `Retry-After`. Digest notifications, not one mail per event, is the standing rule (plan §7.4).

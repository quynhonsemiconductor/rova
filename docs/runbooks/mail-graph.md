# Rova email through Microsoft 365 (Graph, certificate, one mailbox per environment)

Rova sends invitations and notifications through Microsoft Graph `sendMail` using the **Exchange Online RBAC for Applications**
role **Application Mail.Send**, authenticated by a **certificate**, from **one shared mailbox per environment**. This is the owner's setup guide
and the way to prove it. It is the same procedure, in the same order and with the same three-step check (TOKEN / SEND / DENIED), as
`qnsc-kb-backend/docs/runbooks/email-graph.md`, so one person runs one procedure for every product.

Plan: HYBRID-INFRA-PLAN §7.4 (all email through Graph, one mailbox and one app per product, no tenant-wide `Mail.Send`) and Appendix B item 11.

## The design, and why

| Choice | Why |
|---|---|
| **Two Entra apps per environment.** The **sign-in app** (`ENTRA_CLIENT_ID`: delegated, client secret, API only) and the **"Rova <Env> Service" app** (`MAIL_GRAPH_CLIENT_ID`: **certificate only, no client secret, worker only**) | A compromised API process must not hold a credential that can send mail or call Graph. The Service app is the only one that holds application permissions, and the only one with the Exchange role |
| **The Exchange role is on the Service app**, never on the sign-in app | Separation of duties; revoking mail does not touch sign-in |
| **No Graph permission for mail in Entra. Not `Mail.Send`, not `Mail.ReadWrite`, no admin consent for mail** | Entra grants and Exchange RBAC grants are **additive** ([Microsoft: the grants are independent of Entra's](https://learn.microsoft.com/exchange/permissions-exo/application-rbac)). An Entra `Mail.Send` consent lets the app send as **any** mailbox and makes the Exchange scope meaningless. The app's only mail authority is the scoped Exchange role |
| **One management scope per mailbox**, filtered on `PrimarySmtpAddress` | A stolen key can send as that one mailbox and as nobody else |
| **A non-prod environment never sends from the prod mailbox** (decision 2026-10-18) | Develop has its own mailbox `noreply-rova-dev@qnsc.vn` scoped to the **develop** Service app; production uses `noreply-rova@qnsc.vn` scoped to the **production** Service app. Each has its own quota and sending reputation, and a develop mistake cannot send as production. Local stays on the console provider |
| **A certificate, no client secret** | A secret is a string anything that can read the environment can replay; the key lives only in Secrets Manager and the app proves possession by signing a short-lived assertion |
| **Shared mailboxes** | No licence, no sign-in; the sender address needs to exist, not to be a person |

Who can do what: **Exchange**: Organization Management (mailbox, scope, role assignment). **Entra**: Application Administrator or Cloud
Application Administrator (register the app, upload the certificate). **AWS**: write access to the secret (the bundle `rova/<env>/app`, key `mail-graph-certificate`). **No Global
Administrator consent is needed**, which is the point.

## Where things stand (what is missing)

| | develop | production |
|---|---|---|
| Mailbox | `noreply-rova-dev@qnsc.vn` **missing: create it (step 1)** | `noreply-rova@qnsc.vn` exists (2026-10-11) |
| Management scope | missing (step 2) | `noreply-rova` exists (2026-10-11) |
| "Rova <Env> Service" Entra app | **missing: create it, certificate only** (step 3) | **missing: create it** (step 3) |
| Certificate and secret key `mail-graph-certificate` | missing (steps 4-5) | missing (steps 4-5) |
| Exchange role assignment | missing (step 6) | exists, but on the **sign-in app** "Rova Prod" (`503133fe-58c0-4158-86ca-0cecb2f6f376`): **it moves to the Service app** (step 6, then step 10) |
| Switch-on PR | not opened: needs the Service app's client id | not opened: same |

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

## 3. The Entra "Rova <Env> Service" app registration (per environment)

Entra admin center > App registrations > New registration: name `Rova Develop Service` / `Rova Prod Service`,
**single tenant**, no redirect URI. The sign-in apps (`45fabceb-…` develop, `503133fe-…` production) stay as they are. Then:

* **API permissions:** add **nothing** for mail. Rova's Service app holds **no application permission at all** for now (the guest-invite `User.Invite.All` is still on the sign-in app: see Follow-ups). Do not add Microsoft Graph `Mail.Send` or grant admin consent for mail. Remove the default `User.Read` delegated entry (unused).
* Record three IDs: **Application (client) ID** and **Directory (tenant) ID** from the app's Overview, and the **Object ID of the enterprise
  application** (Enterprise applications > the app > Object ID). Do **not** use the Object ID on the *App registrations* page; it is a different
  object and Exchange rejects it. If the enterprise application does not exist: `az ad sp create --id <client-id>`.
* **Do not create a client secret** on this app.

## 4. The certificate

On a trusted workstation (not a CI runner). Two years; put the renewal in the calendar. The key never leaves your terminal except into the
secret in step 5.

```bash
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 730 \
  -keyout mail.key -out mail.crt -subj "/CN=rova-service-<env>"
openssl x509 -in mail.crt -noout -enddate -fingerprint -sha256
```

* Upload **`mail.crt` only** to the app: Certificates & secrets > Certificates > Upload certificate.
* RSA only: the client assertion is RS256 and the library refuses an EC key.

## 5. The secret (do this BEFORE the switch-on PR)

The certificate is a key of the environment's bundle JSON, `rova/develop/app` or `rova/production/app` (both run with `secrets_use_bundle = true`),
as **one base64 line** holding the key followed by the certificate. **Merge it into the existing JSON; do not replace it**: a plain `put-secret-value`
with only this key erases every other secret of the app. The value travels through the environment and a pipe, never argv or the terminal:

```bash
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
export PEM_B64="$(cat mail.key mail.crt | base64 | tr -d '\n')"
aws secretsmanager get-secret-value --secret-id rova/develop/app --query SecretString --output text \
  | python3 -c 'import json,os,sys; d=json.load(sys.stdin); d["mail-graph-certificate"]=os.environ["PEM_B64"]; print(json.dumps(d))' \
  | aws secretsmanager put-secret-value --secret-id rova/develop/app --secret-string file:///dev/stdin
unset PEM_B64
# Verify WITHOUT printing the value: the key exists, and the old keys are all still there
aws secretsmanager get-secret-value --secret-id rova/develop/app --query SecretString --output text \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sorted(d)); print("mail-graph-certificate:", len(d["mail-graph-certificate"]), "chars")'
```

The list must show the new key **and** all the old ones. Do not skip it: the deploy preflight checks that the bundle holds a value, not that each key
exists, and a missing key fails the task at boot in a log that does not name the key.

Keep `mail.key` only until the verification in step 8 has passed, then `shred -u mail.key` (or `rm -P mail.key` on macOS). Keep `mail.crt` and
the expiry date.

## 6. Exchange RBAC for Applications (the only grant)

```powershell
Connect-ExchangeOnline
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Rova <Env> Service"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" `
  -CustomResourceScope "Rova mail develop"      # production: the production scope

Get-ManagementRoleAssignment -RoleAssignee "Rova <Env> Service" | Format-List Role, CustomResourceScope
# In scope for its own mailbox, NOT for the other environment's, NOT for another product's:
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply-rova-dev@qnsc.vn   # InScope : True   (develop app)
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply-rova@qnsc.vn       # InScope : False  (develop app)
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource noreply-opshub@qnsc.vn               # InScope : False
```

`Test-ServicePrincipalAuthorization` reads Exchange only and bypasses its permission cache; it **does not see Entra grants**. Real Graph calls
can lag a fresh assignment (Microsoft's guidance is up to roughly half an hour, and the first `New-ManagementRoleAssignment` in a tenant took
about an hour on 2026-10-11, see Appendix B item 11); if step 8 returns 403 on the *allowed* mailbox straight after this, wait and retry before
debugging.

## 7. Make sure there is NO mail grant in Entra

Entra admin center > Enterprise applications > the Service app > Permissions: **empty** of Microsoft Graph application permissions (Rova's Service app has none).

```powershell
Connect-MgGraph -Scopes "Application.Read.All"
$sp = Get-MgServicePrincipal -Filter "appId eq '<client-id>'"
Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id | Select-Object AppRoleId, ResourceDisplayName
```

If a Microsoft Graph `Mail.*` role is listed (especially `Mail.Send`), **remove it**. This is the step people skip, and it is what makes the 403
negative test fail in step 8.

## 8. Prove it, including the 403

With the Service app's own sender, from a workstation that holds `mail.crt` and `mail.key`, in a checkout of this repository after
`pnpm install` (the check ships in `@quynhonsemiconductor/platform-mail`):

```bash
# DEVELOP app: sends as the dev mailbox, must be REFUSED as the PROD mailbox
pnpm exec platform-mail-check \
  --tenant <tenant-id> --client-id <develop-service-app-client-id> --cert mail.crt --key mail.key \
  --sender noreply-rova-dev@qnsc.vn --to <your address> --denied-mailbox noreply-rova@qnsc.vn
# and once more against another product's mailbox
pnpm exec platform-mail-check ... --denied-mailbox noreply-opshub@qnsc.vn
```

Expected, in order:

```
PASS  TOKEN   issued for appid=<client-id>; roles in the token: none (expected when authority comes from Exchange RBAC only)
PASS  SEND    sent as noreply-rova-dev@qnsc.vn to <you> (HTTP 202)
PASS  DENIED  as noreply-rova@qnsc.vn: forbidden HTTP 403 (request-id ...)
```

* `DENIED` is the **negative test** and the proof that the scope works. **For develop it must be the PRODUCTION mailbox that is refused.** Only
  a refusal with **403** passes. If it says the send was *accepted*, the app can send as anyone: go back to step 7.
* For production, the same with the production Service app, `--sender noreply-rova@qnsc.vn` and `--denied-mailbox noreply-rova-dev@qnsc.vn`
  (then once more against another product's mailbox).
* If the token's `roles` lists `Mail.Send`, step 7 was not done (the check also prints a `FAIL SCOPE` line).
* `TOKEN` failing with `AADSTS700027` (invalid assertion signature) or `AADSTS700024`: the certificate uploaded to Entra is not the one whose key
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
     --overrides '{"containerOverrides":[{"name":"<worker-container>","command":["sh","-c","MAIL_TRANSPORT=graph AZURE_TENANT_ID=$ENTRA_TENANT_ID AZURE_CLIENT_ID=$MAIL_GRAPH_CLIENT_ID AZURE_CLIENT_CERTIFICATE=$MAIL_GRAPH_CERTIFICATE MAIL_SMOKE_TO=<you>@qnsc.vn node node_modules/@quynhonsemiconductor/platform-mail/dist/smoke/cli.js"]}]}'
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
   Get-ManagementRoleAssignment -RoleAssignee "Rova Prod" | Format-List Name, Role, CustomResourceScope
   Remove-ManagementRoleAssignment -Identity "<the assignment's Name from above>"
   Test-ServicePrincipalAuthorization -Identity 503133fe-58c0-4158-86ca-0cecb2f6f376 -Resource noreply-rova@qnsc.vn   # InScope : False (or Not Run)
   ```

   Leave the sign-in app's Exchange service-principal pointer if you like; with no assignment it grants nothing.

If step 2 fails, nothing was lost: the old assignment still lets the sign-in app send, and production is still on SES until step 9.

## When Graph refuses a message

* A **permanent** answer (400/403/404/413: the mailbox, the app or the message is wrong) is **not retried**: the row is tried once and
  **dead-lettered at once** (`email_outbox.status = 'failed'`, `last_error` carries the code, the status and Microsoft's request id, never a recipient
  or a body). The worker logs it with `outboxDeadLetter`, which the **`outbox-dead-letter` alarm** matches; it does not sit retrying forever, and
  it does not open the circuit breaker for the emails that would have worked.
* A **throttle** (429) honours Microsoft's `Retry-After`; a 5xx or a timeout retries with backoff, up to the relay's five attempts, then dead-letters.
* After the cause is fixed (a role assignment, a mailbox), the failed rows are **not retried by themselves**. List them, then re-queue only the
  ones you want, once:

  ```sql
  SELECT id, "to", template, attempts, left(last_error, 120) FROM messaging.email_outbox
  WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50;

  UPDATE messaging.email_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
  WHERE id IN (<the ids>);
  ```

## Rotation and revocation

* **Rotate (before the expiry date):** generate a new pair, upload the new certificate in Entra **next to** the old one, replace the secret (as in
  step 5), redeploy the worker, verify with step 8, then delete the old certificate in Entra.
* **Revoke now:** delete the certificate in Entra (new tokens stop at once; an issued token lives up to an hour). To cut the app off from the mailbox
  as well: `Remove-ManagementRoleAssignment` for its assignment.
* **The k3s move** (no certificate): add a **federated credential** to the same Service app (issuer `https://oidc.<domain>/onprem`, subject
  `system:serviceaccount:rova:worker`, audience `api://AzureADTokenExchange`), mount the projected token, set `MAIL_GRAPH_FEDERATED_TOKEN_FILE`, and delete the
  certificate. The federated token wins whenever it is set, so nothing else changes.

## Local development

`EMAIL_PROVIDER=dev` (the `.env.example` default) writes the message to the log and sends nothing. It is never `graph` locally.

## Follow-ups (not in this change)

* **`User.Invite.All` stays on the sign-in app in this change.** Rova's Entra B2B guest invitation (worker, develop) uses the sign-in app's application
  permission today. It moves to the Service app with Phase 4 (D), together with its credential; until then the sign-in app is not yet delegated-only.
* **Remove SES and Resend** (the `ses`/`resend` providers, `SES_*` and `MAIL_FROM_*` variables, the `ses:SendEmail` grants, the SES configuration set, SNS topic and
  SQS bounce queue with their alarms) in one cleanup PR **after both environments are proven on Graph**: removing them earlier stops the API at boot, because the
  deployed task definitions still name `ses`. SES identity and DNS stay in infra/edge until all three products are off SES.
* **Bounce feedback is gone with SES.** Graph reports no bounce events; a non-delivery report arrives in the shared mailbox. `email_outbox.status = 'sent'`
  then means "accepted by Graph". Reading the mailbox for NDRs is a later decision (platform-mail lists bounce handling as a later ADR); until then someone
  who needs to know a mistyped address bounced reads the mailbox.
* **Volume.** Exchange limits are per mailbox (about 30 messages a minute, 2,000 external recipients a day from October 2026). The relay is not paced to
  Graph's limit; the transport honours `Retry-After`. Digest notifications, not one mail per event, is the standing rule (plan §7.4).

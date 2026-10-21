# SCM Connections — GitHub App & Backfill (runbook)

Rova links GitHub pull requests and commits to work items when their title,
branch, or commit message references a work-item key (e.g. `US-42`). This runbook
covers the **Phase 2** setup: a dedicated GitHub App that (a) auto-delivers
webhook events for every installed repo and (b) lets Rova backfill a repo's
**existing** PRs/commits over the REST API when you map it.

Phase 1 (inbound webhook → HMAC verify → `scm.webhook_inbox` → worker relay →
linker) still works on its own; the App just replaces per-repo webhook setup and
adds history.

---

## 1. Register the "Rova SCM" GitHub App (org admin)

On github.com → your org → **Settings ▸ Developer settings ▸ GitHub Apps ▸ New GitHub App**:

- **Homepage URL**: your Rova URL.
- **Webhook ▸ Active**: on.
  - **Webhook URL**: `https://<rova-host>/v1/scm/webhook/github`
  - **Webhook secret**: a strong random string — this becomes `GITHUB_WEBHOOK_SECRET`.
- **Permissions ▸ Repository**:
  - Pull requests: **Read-only**
  - Contents: **Read-only**
  - Metadata: **Read-only** (mandatory)
- **Subscribe to events** (all five are required for the org-level model):
  - **Pull request**, **Push** — artifact linking (Connections / Changesets).
  - **Installation** — App installed/uninstalled/suspended → bind/deactivate.
  - **Installation repositories** — a repo added to / removed from the install →
    auto-register + backfill / deactivate. **This is what makes a newly-created
    repo appear in Rova automatically.**
  - **Repository** — a repo archived/unarchived after discovery → deactivate /
    re-register (archived repos stop emitting events, so they are dropped).
- **Where can this app be installed**: Only on this account.

Create it, then:
1. Note the **App ID**.
2. **Generate a private key** — downloads a `.pem` (PKCS#1 or PKCS#8; the auth
   service accepts both).
3. **Install** the App on the org. Choose **All repositories** so future repos
   auto-appear (with *Selected repositories*, an admin must add each new repo to
   the install before it flows to Rova). Archived/disabled repos are skipped
   automatically on discovery.

## 2. Provide credentials to Rova

Config keys (`libs/platform/src/config/env.schema.ts`):

| Key | Value | Notes |
|-----|-------|-------|
| `GITHUB_APP_ID` | the App ID | required for App auth |
| `GITHUB_WEBHOOK_SECRET` | the webhook secret above | already used by the Phase-1 receiver |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | default; only change for GHE |
| `GITHUB_APP_PRIVATE_KEY` | the PEM contents | **local/dev** — literal `\n` are normalised |
| `GITHUB_APP_PRIVATE_KEY_SECRET_REF` | a Secrets Manager ARN | **prod** — resolved via `SECRET_RESOLVER`; takes over from the inline key |

In production the private key lives in Secrets Manager and Terraform already wires the
ref — the secret is `rally/<env>/github-app-private-key`, created empty. Paste the PEM in
and leave `GITHUB_APP_PRIVATE_KEY` unset:

```bash
aws secretsmanager put-secret-value \
  --secret-id rally/<env>/github-app-private-key \
  --secret-string file://rova-scm.private-key.pem \
  --region ap-southeast-1
```

Everything is optional — if unset, backfill logs "GitHub App not configured — skipping"
and webhooks still function. An empty secret cannot be injected, so the deploy preflight
in qnsc-ci blocks the deploy rather than letting a task start without it.

## 3. Connect the organization (Settings ▸ Integrations)

Org-level, no per-repo typing. Under **Connected organizations**, click
**Connect GitHub** and pick the App installation. Rova then:

- binds the installation to the workspace (`scm.installations`),
- discovers every **active** repo it can access (`GET /installation/repositories`,
  archived/disabled skipped) and registers each, and
- **auto-enqueues a backfill** per repo (historical PRs/commits that reference a
  work-item key). Use **Sync now** on a row, or **Sync all**, to re-enqueue.

Thereafter it stays in sync with no manual step, driven by the webhooks above:
new repo → auto-registered + back-filled; repo removed/archived → dropped; App
uninstalled → all its repos deactivated. **Disconnect** clears the org's repos
from the dashboard (reconnect re-adds the active ones).

Linking needs no repo→project mapping: work-item keys are unique per **workspace**
(FormattedID, Rally's key format), so any `US-42` in a PR title / branch / commit resolves
workspace-wide — Rally's org-scoped model.

**Add manually** (fallback) — for a repo outside a connected installation, add it
as `owner/name`; same backfill-on-add behaviour.

## How it works

- **Auth** (`github-app-auth.service.ts`): mints an App JWT (RS256, `iss`=App ID,
  ≤10 min) → resolves the repo's installation id (`GET /repos/{o}/{r}/installation`)
  and caches it on `scm.repositories.installation_id` → exchanges it for a
  short-lived installation token (`POST /app/installations/{id}/access_tokens`),
  cached in memory until ~1 min before expiry.
- **Backfill** (`scm-backfill.service.ts`): lists ~100 most-recent PRs (all states)
  and commits from the last ~90 days (page-capped so a huge repo can't run away or
  exhaust the 5k/hr rate limit), maps them to the **same** normalized shapes as the
  webhook parser, and links via the **same idempotent** upsert path. Commit file
  lists are fetched only for commits that actually reference a key.
- **Async job**: `POST /v1/scm/repositories/{id}/sync` (and repo creation) inserts a
  row into `scm.backfill_jobs`. The worker's `ScmBackfillRelayService` drains it on a
  30 s cron, one repo at a time, and records `{prs, commits, connections, changesets}` on
  the job row. The relay is lease-and-fence: a short claim transaction spends the attempt and
  stamps a lease, the run happens with **no transaction open**, and a fenced finish writes the
  result (exponential-backoff retry, dead-letter after five attempts). A run has a hard
  **8-minute network budget** and each GitHub request a 30 s deadline, both as `AbortSignal`s;
  the lease is derived from them (`BACKFILL_RUN_BUDGET_MS` + one call + a margin). A run that
  exhausts the budget fails as an ordinary retryable error.

Idempotency: connections upsert on `(work_item_id, external_id)`, changesets on
`(work_item_id, revision)`. Re-running a backfill, retrying a failed job, or
overlapping with a live webhook never duplicates rows.

## Verify

1. Connect the org (or add a repo manually) that has PRs/commits referencing
   existing work-item keys.
2. Within ~30 s, open one of those work items → **Connections** tab shows the
   linked PRs; **Changesets** shows the commits.
3. `select status, counts, last_error from scm.backfill_jobs order by requested_at desc limit 5;`
   — the latest row should be `done` with non-zero counts.
4. Open a new PR referencing a key → it appears via the App webhook (no per-repo
   webhook configured).

## Troubleshooting

- **Backfill job stuck `failed`** — check `last_error`. `401/403` → App not installed
  on that repo, or wrong key/App ID. `404` on `/installation` → the App isn't
  installed on the repo's owner.
- **No links despite a `done` job with `prs`/`commits` > 0** — the PRs/commits
  reference keys that don't exist in this workspace (wrong key, or a different
  workspace).
- **Newly-created repo doesn't appear** — the App is on *Selected repositories*
  (add the repo to the install), or it isn't subscribed to the **Installation
  repositories** event.
- **`Connect GitHub` picker is empty** — the API can't read the App private key:
  check `GITHUB_APP_ID` + the task role's `GetSecretValue` on the key secret.
- **`SECRET_RESOLVER unavailable`** — `GITHUB_APP_PRIVATE_KEY_SECRET_REF` is set but
  the resolver isn't wired; set the inline `GITHUB_APP_PRIVATE_KEY` for local use.

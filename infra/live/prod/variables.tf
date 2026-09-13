variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag to deploy for api & worker. CI overrides this with the release sha to pin prod images; defaults to 'latest' for a bare apply."
}





variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare API token (Zone:DNS:Edit on qnsc.vn). Supplied via TF_VAR_cloudflare_api_token in CI. Zone ID is read from qnsc-infra bootstrap via _shared remote state, not an input."
}

variable "alarm_emails" {
  description = <<-EOT
    Addresses subscribed to the alarm topic. Terraform creates the subscription;
    each recipient must still click the confirmation link AWS emails them, so a
    freshly-added address receives nothing until it does.
  EOT
  type        = list(string)
  # devops@qnsc.vn is an M365 SHARED MAILBOX, deliberately, not an alias on a person.
  # Recipients are managed in the admin centre rather than here, so adding or removing
  # someone is not a Terraform change across four repos, and the address survives any
  # individual leaving. Confirm the subscription once from inside that mailbox — AWS
  # delivers nothing until someone clicks the link.
  default = ["devops@qnsc.vn"]
}

variable "platform_admin_emails" {
  description = <<-EOT
    Emails auto-granted workspace_admin on every SSO login. A variable rather than a
    literal in the stack so the two environments can differ (and so adding a
    colleague is a values change, not a module change).
  EOT
  type        = list(string)
  default     = ["nghiavt@qnsc.vn", "quangld@qnsc.vn", "hieuvbm@qnsc.vn", "anhntn@qnsc.vn"]
}

// ── Public identifiers, held in git on purpose ────────────────────────────────
// These are NOT secrets: an Entra tenant/client id appears in the browser's auth
// redirect, a GitHub App id is public, and a Cloudflare account id identifies the
// account without authorising anything. The corresponding SECRETS live in Secrets
// Manager (entra-client-secret, github-app-private-key) and the Cloudflare API
// token stays a GitHub secret.
//
// They used to arrive as TF_VARs from GitHub Actions variables, which made
// `infra-plan` lie: ENTRA_CLIENT_ID is environment-scoped, the plan job has no
// `environment:` context (adding one would gate every PR behind the production
// reviewer), so it resolved to "" and every plan reported three ECS task
// definitions "must be replaced". Reviewers who see phantom replacements on every
// PR stop reading plans — which is exactly when a real one slips through.
//
// In git the value is identical at plan and apply time, so the plan tells the truth
// and the value is reviewable in a diff.

variable "entra_tenant_id" {
  description = "Microsoft Entra tenant id (public)."
  type        = string
  default     = "dc0f2078-ac28-4ff2-b21a-d4b28df32361"
}

variable "entra_client_id" {
  description = "Entra application (client) id for this environment — a distinct app registration per environment."
  type        = string
  default     = "503133fe-58c0-4158-86ca-0cecb2f6f376"
}

variable "github_app_id" {
  # Production has its OWN App registration, separate from develop's 4390002, so a
  # develop misconfiguration cannot touch production's installation or its webhooks.
  #
  # This was empty while no App existed, which left the SCM path dormant — correct at
  # the time. It stayed empty after the App was registered, so production shipped with
  # GITHUB_APP_ID="" on the running task definition: no PR/commit linking, no backfill,
  # and the webhook receiver answering 503. The id lived only in a GitHub environment
  # variable that nothing reads.
  #
  # Held in git, not in an Actions variable, for the reason in .github/workflows/
  # infra-plan.yml: an environment-scoped variable is invisible to a plan job, which
  # made every plan report three phantom task-definition replacements.
  description = "GitHub App id for SCM discovery/backfill (public)."
  type        = string
  default     = "4398910"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the Pages project (public identifier)."
  type        = string
  default     = "69e52835cf2d08edde5b6ebd741d30fa"
}

variable "otlp_endpoint" {
  description = <<-EOT
    OTLP/HTTP base URL of the telemetry backend — qnsc-infra's live/observability
    stack, region prod-ap-southeast-0, with the `/otlp` suffix the otlphttp
    exporter needs (the stack's own `otlp_url` output omits it).

    Setting this creates the `observability-token` Secrets Manager secret (empty)
    and flips the sidecar on in the task definition — but the secret's VALUE must
    be populated by hand (Basic base64(stack_id:token), never through Terraform —
    see modules/stack/main.tf) and the service must be DEPLOYED before telemetry
    actually flows. Blank would keep telemetry dormant; this repo's stack is live,
    so blank is no longer the deliberate default.
  EOT
  type        = string
  default     = "https://otlp-gateway-prod-ap-southeast-0.grafana.net/otlp"
}

variable "grafana_alerting_url" {
  description = "The Grafana instance URL — qnsc-infra's live/observability stack's `alerting_grafana_url` output. Same value in every environment; not a secret."
  type        = string
  default     = "https://qnsc.grafana.net"
}

variable "grafana_alerting_auth" {
  description = <<-EOT
    Stack service account token — qnsc-infra's live/observability stack's
    `alerting_service_account_token` output. Reaches Terraform via
    TF_VAR_grafana_alerting_auth in CI (GRAFANA_ALERTS_TOKEN secret), NEVER
    through AWS Secrets Manager — see modules/stack/variables.tf's
    grafana_alerting_auth for why. Blank keeps Grafana Alerting dormant
    (module.alerts is count-gated to zero); CloudWatch Alarms are unaffected
    either way.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "grafana_alerting_prometheus_datasource_name" {
  description = "qnsc-infra's live/observability stack's `alerting_prometheus_datasource_name` output. Same value in every environment; not a secret."
  type        = string
  default     = "grafanacloud-qnsc-prom"
}

variable "grafana_logs_datasource_name" {
  description = "Grafana Cloud's auto-provisioned Loki datasource name for this stack (confirmed against the stack's own Details page, same naming convention as the Prometheus one). Same value in every environment; not a secret."
  type        = string
  default     = "grafanacloud-qnsc-logs"
}

variable "grafana_dashboards_folder_uid" {
  description = <<-EOT
    qnsc-infra's live/observability stack's `dashboards_folder_uid` output —
    the PARENT folder every product's own dashboard subfolder nests under.
    A DIFFERENT folder from grafana_alerting_folder_uid below; do not merge
    them.

    Empty until qnsc-infra's Dashboards folder is applied and its real UID
    backfilled here — same bootstrap sequencing grafana_alerting_folder_uid
    itself went through. Still unset: nothing in this repo currently reads
    it directly (rally's own dashboards nest under
    grafana_rally_dashboards_folder_uid below, not this one).
  EOT
  type        = string
  default     = ""
}

variable "grafana_rally_dashboards_folder_uid" {
  description = <<-EOT
    qnsc-infra's live/observability stack's `rally_dashboards_folder_uid`
    output — rally's own dashboard SUBFOLDER, nested under the parent
    above. Same value in every environment; not a secret.

    Used to be a `grafana_folder` resource created per-environment inside
    infra/modules/stack — since develop and prod are separate Terraform
    root modules with separate state, that created two real, separate
    "Rally" folders (confirmed live). Now a plain UID, created once,
    centrally, same as grafana_alerting_folder_uid — see that variable's
    own description for the destroy+recreate fragility this inherits.
  EOT
  type        = string
  default     = "cfwpy0n7xqcqoc"
}

variable "grafana_alerting_folder_uid" {
  description = <<-EOT
    qnsc-infra's live/observability stack's `alerting_folder_uid` output —
    the shared folder every product's rule groups live under. Same value
    in every environment; not a secret.

    This is a HARDCODED UID, not a live reference, and that is a real
    fragility: setting `parent_folder_uid` on an EXISTING Grafana folder
    forces a destroy+recreate in the Terraform provider (not an in-place
    move, confirmed the hard way — qnsc-infra#98's re-parenting under a new
    "QNSC" company folder destroyed and recreated this folder, its
    contents (including rally's own alert rule group and 2 dashboards),
    AND `rally_dashboards_folder_uid` above, which depends on it). Every
    UID here needs re-backfilling whenever that happens again. A
    `terraform_remote_state` read against qnsc-infra's own state would
    self-heal instead of silently going stale — worth doing before the
    next folder change, not after.
  EOT
  type        = string
  default     = "efwpy0l5x8nwgb"
}

variable "grafana_slos_folder_uid" {
  description = <<-EOT
    qnsc-infra's live/observability stack's `slos_folder_uid` output —
    the shared folder every product's SLOs live under. Same value in
    every environment; not a secret.

    Was never set until this variable existed, which left rally's
    grafana_slo resource in Grafana's own default SLO folder outside the
    QNSC company tree everything else here lives under.
  EOT
  type        = string
  default     = "ffwpy0lokzcw0e"
}

# Enterprise Release / CD Hardening — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming) → pending implementation plan
**Scope:** Org-wide (QNSC-VN) release, deploy, and supply-chain flow

---

## Problem

An org-wide audit (qnsc-ci reusables + all product/infra repos) found one
release-blocking bug and a tier of enterprise gaps in the shared CD flow.

1. **Release tags never trigger deploys (P0).** Every monorepo's
   `release-please-config.json` sets `tag-separator:""`, `include-v-in-tag:true`,
   and omits `include-component-in-tag` (defaults `true`), so release-please cuts
   `rally-apiv0.2.0` / `opshub-apiv0.2.0`. Both deploy workflows trigger only on
   `v[0-9]+.[0-9]+.[0-9]+`. The prefixed tag never matches → merging the Release
   PR produces a tag + GitHub Release + PR back-comments but **deploys nothing**.
   The Release PR body even promises a prod deploy that never happens.

2. **Broken merge gate (P1).** `opshub` and `qnsc-infra` rulesets require the
   status context `security / Secret scan (Gitleaks)`, but both run Gitleaks as
   an *inline* job that emits the bare context `Secret scan (Gitleaks)`. The
   required check never reports → the gate hangs / blocks. `delete_branch_on_merge`
   is off org-wide.

3. **Deploy safety + supply chain (P2).** No ECS deployment circuit breaker or
   auto-rollback (a failed deploy leaves the bad revision live; the `rollback`
   notify status is dead code). The prod migrator runs `:latest` rather than the
   promoted image. Attestation is SLSA-L2, `continue-on-error` (never blocks),
   and only on the develop build — never on the promoted prod image, never
   verified before rollout. Semgrep (SAST) and osv (dep CVEs) are report-only.
   Callers pin the shared `qnsc-ci` reusables to a floating `@v1` that the repo's
   own `tag-sync` force-moves on every push — no reproducibility.

## Guiding decisions (locked in brainstorming)

- **Monorepo is canonical.** `rova` and `opshub` monorepos are the source of
  truth. The split `*-api` / `*-web` repos are legacy and out of scope (archive
  tracked separately). `qnsc-ci` is the single shared CI; `qnsc-gitops` (used
  only by the split repos) is retired for products.
- **Phased-strict security.** Keep Trivy-CRITICAL + Gitleaks blocking now; flip
  Semgrep + osv to block on HIGH+ only after baselining/allowlisting existing
  findings. Add attestation as a blocking, verified gate. Defer cosign signing.
- **Immutable pinning + Renovate.** `qnsc-ci` publishes immutable release tags;
  callers pin `@vX.Y.Z`; Renovate opens controlled bump PRs.
- **Delivery: shared-first, in waves.** Each wave is its own spec → plan → PR(s),
  ordered by risk-reduced-per-effort.

## Non-goals

- Staging/pre-prod gate (explicitly excluded by product owner).
- cosign image signing (deferred; GitHub-native attestation is the interim bar).
- Archiving the legacy split repos (ops task, tracked separately).
- Progressive delivery (blue/green, canary) — future, not this program.

---

## Design — three waves

### Wave 0 — Unblock releases (fast, low-risk)

**W0.1 Tag fix (repo config; PR).** Add `"include-component-in-tag": false` to
the package in `release-please-config.json` for **rova** and **opshub**. Result:
tags become `vX.Y.Z`, matching the existing deploy glob. Leave `qnsc-app-platform`
unchanged (multi-package library — component-prefixed tags are correct and its
`publish.yml` matches them).
*Verify:* `npx release-please … --dry-run` (or inspect the computed tag) shows
`v0.2.0` before merge. No tags exist org-wide yet → no history migration.

**W0.2 Gitleaks gate alignment (settings; run/approve).** Per repo, set the
ruleset's required status context to the **name the workflow actually emits**:
- Reusable-caller (job `security: uses: qnsc-ci/.../security.yml`) → `security / Secret scan (Gitleaks)` (rova — already correct).
- Inline runner → bare `Secret scan (Gitleaks)` (fix opshub, qnsc-infra to require the bare name).
Rule: match the ruleset to reality; do not blanket-add the prefix. Also normalize
`opshub-web`'s lowercase `Secret scan (gitleaks)` job name (legacy split — skip
if that repo is being archived).

**W0.3 Hygiene (settings; run/approve).** Enable `delete_branch_on_merge` on all
active repos.

### Wave 1 — qnsc-ci deploy hardening (cut immutable `v1.4.0`)

All changes land in the shared `QNSC-VN/qnsc-ci` `backend-deploy.yml` reusable
(and web where applicable), so every monorepo inherits them.

**W1.1 ECS deployment circuit breaker + rollback.** Set
`deploymentConfiguration.deploymentCircuitBreaker = { enable: true, rollback: true }`
on the ECS service update. A failed rollout auto-reverts to the last stable task
def.

**W1.2 Migrator image pinning.** Before running migrations on prod, re-register
the migrator task-def with the exact promoted image tag (`vX.Y.Z`) instead of
relying on the `:latest`-pinned `ECS_MIGRATOR_TASK_DEF`. Guarantees the schema
migration runs the same image bytes being deployed.

**W1.3 Blocking, verified attestation.** Drop `continue-on-error` on the attest
step (make it block). Attest the **promoted prod** image (not only the develop
build), and run `gh attestation verify` against the promoted digest before the
ECS roll. cosign remains deferred.

**W1.4 Wire the dead rollback notification.** The `notify-deploy` composite
already accepts a `rollback` status; invoke it on a failed verify/health-check so
operators are alerted when the circuit breaker reverts.

*Verify:* exercise on a develop deploy; prove auto-rollback with a synthetic
failing deploy (bad health path / image) and confirm the service reverts + the
rollback notification fires.

### Wave 2 — Supply-chain posture (phased)

**W2.1 Baseline then block scans.** Run Semgrep + osv in report mode, triage and
allowlist current findings, then flip `semgrep_blocking` / `osv_blocking` to true
gated on **HIGH+**. Keep Trivy-CRITICAL + Gitleaks blocking throughout.

**W2.2 Immutable pinning + Renovate.** `qnsc-ci` publishes immutable version tags
(starting `v1.4.0` from Wave 1). Caller repos pin `qnsc-ci@v1.4.0` (workflows and
composite actions), replacing floating `@v1`. Add a Renovate config org-wide to
open bump PRs for `qnsc-ci` and third-party actions. Retain a documented process
for emergency org-wide CI fixes (cut a patch release, Renovate fast-tracks).

---

## Success criteria

- Merging a Release PR creates `vX.Y.Z`, which triggers backend + web deploy.
- Prod deploy is gated by the `production` GitHub Environment reviewer.
- Deploy self-verifies (`services-stable` + health check) and **auto-rolls-back**
  on failure, with a rollback notification.
- DB migration on prod runs the exact promoted image.
- Released image attestation is verified before rollout; attestation failure
  blocks.
- Merged PRs get the `released: vX.Y.Z` back-comment + label; branches auto-delete.
- Gitleaks (and all required) checks report and pass — no hung gates.
- CI is reproducible: repos pin `qnsc-ci@vX.Y.Z`; Renovate manages bumps.
- Semgrep + osv block on HIGH+.

## Rollout order & risk

1. **Wave 0** — this session where possible. Config PRs (I implement) unblock
   releases immediately; settings changes (rulesets, branch-delete) are run or
   approved by an org admin.
2. **Wave 1** — one `qnsc-ci` PR → cut `v1.4.0`; validate on develop + synthetic
   failure before any repo pins to it.
3. **Wave 2** — baseline scans (observe), then flip blocking; introduce Renovate
   + version pins referencing `v1.4.0`.

## Verification approach

- **W0:** release-please dry-run confirms `vX.Y.Z`; ruleset context matches a live
  check-run name; branch-delete observed on a test merge.
- **W1:** develop deploy green; synthetic bad deploy auto-reverts + notifies;
  migrator task-def shows the deploying tag.
- **W2:** baseline scan report reviewed/allowlisted before blocking is enabled;
  a repo build succeeds against the pinned `qnsc-ci@v1.4.0`; Renovate opens a
  bump PR.

## Open items / follow-ups (not blocking this program)

- Archive legacy split `*-api` / `*-web` repos; retire `qnsc-gitops` once no repo
  references it.
- Revisit cosign signing and progressive delivery after Wave 2 lands.
- `ceo-suite` / `product-docs` rulesets were inaccessible (private, no Pro) —
  confirm their gate config out-of-band.

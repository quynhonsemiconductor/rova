# Release/CD Hardening — Wave 2 (Supply-Chain Posture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the CI supply chain reproducible and enforcing — pin every product to an immutable `qnsc-ci@v1.4.0` with Renovate managing bumps, and flip Semgrep (SAST) + osv-scanner (deps) from report-only to blocking after a baseline/allowlist pass.

**Architecture:** Two independent tracks. (A) **Enforcement** — per-repo triage config (`.semgrepignore`, `osv-scanner.toml`) then set `semgrep_blocking:true` / `osv_blocking:true` in each product's security caller. Existing HIGH+ findings are what remain un-allowlisted, so blocking effectively gates HIGH+. (B) **Pinning** — replace floating `@v1` with `@v1.4.0` in caller workflows and add a shared Renovate preset so bumps are reviewed PRs, not silent force-moves.

**Tech Stack:** GitHub Actions reusable workflows, Semgrep (OSS), osv-scanner, Renovate.

**Reference spec:** `docs/superpowers/specs/2026-07-13-release-cd-hardening-design.md` (Wave 2).
**Prerequisites:** Wave 1 merged and **`qnsc-ci v1.4.0` tag exists** (Tasks 4–5 pin to it). Track A (Tasks 1–3) can run independently of the tag.
**Scope:** canonical monorepos `rova`, `opshub` (+ any active repo calling the security reusable: qnsc-app-platform, qnsc-landing). Legacy split repos excluded.

---

## Track A — Flip Semgrep + osv to blocking (phased)

### Task 1: Baseline the current findings (observational, per repo)

**Why:** You cannot safely flip blocking without knowing what currently fails. Capture the report-only output first.

- [ ] **Step 1: Trigger a security run and read findings for each repo**

For `rova` then `opshub`, open (or re-run) the latest `Security · Scan` run and capture the Semgrep + osv sections:
```bash
unset GITHUB_TOKEN GH_TOKEN
repo=rova   # then opshub
rid=$(gh run list --repo QNSC-VN/$repo --workflow="Security · Scan" -L1 --json databaseId -q '.[0].databaseId')
gh run view "$rid" --repo QNSC-VN/$repo --log 2>/dev/null | grep -iE 'semgrep|osv|finding|vuln|WARNING|ERROR' | tee /tmp/$repo-sec-baseline.txt | head -80
```
Expected: a list of Semgrep rule hits and osv vulnerable packages. Record counts + severities. This is the triage worklist — no code change in this task.

- [ ] **Step 2: Decide the bar**

Rule of thumb: allowlist INFO/WARNING (Semgrep) and un-fixable/low osv advisories with justification; leave HIGH/ERROR + fixable CVEs un-allowlisted so they block. Note which findings you will fix vs allowlist.

### Task 2: Add triage/allowlist config (per repo)

**Files (per repo, repo root):**
- Create: `.semgrepignore`
- Create: `osv-scanner.toml`

- [ ] **Step 1: Create `.semgrepignore`** (paths + accepted rules). Example — adjust to Step-1 findings; keep it minimal and commented:

```gitignore
# Build output & vendored code — not our source to fix.
dist/
apps/*/dist/
**/*.generated.ts
# Test fixtures deliberately contain insecure patterns.
**/__fixtures__/
# Accepted rule (justification + owner + date). Prefer inline `// nosemgrep: <rule-id>`
# at the specific line over a blanket ignore where possible.
```

- [ ] **Step 2: Create `osv-scanner.toml`** for accepted advisories (one block per ignored vuln, with reason + review date):

```toml
# Each ignore MUST have a reason and a reviewUntil date; re-triage on expiry.
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
reason = "No fixed upstream version; not reachable from our code paths."
# reviewUntil = 2026-10-01
```
(If Step 1 found nothing to accept, create the file with only the header comment so the gate has a documented home. `osv-scanner --recursive .` auto-discovers `osv-scanner.toml` at the root.)

- [ ] **Step 3: Fix (don't allowlist) the findings above your bar**

For fixable dependency CVEs, bump the dependency (`pnpm up <pkg>`), run the app's tests, commit. For real Semgrep ERROR findings, fix the code. Only allowlist what you consciously accept.

- [ ] **Step 4: Commit the triage config (per repo)**

```bash
git add .semgrepignore osv-scanner.toml
git commit -m "chore(security): baseline Semgrep + osv allowlist before enforcement

Documented, justified ignores for accepted findings; HIGH+/fixable issues
fixed. Prepares the gate to be flipped to blocking."
```

### Task 3: Flip blocking in each security caller

**Files (per repo):** the security caller workflow (rova: `.github/workflows/backend-security.yml`; opshub: its `security.yml`/inline job; others: `.github/workflows/security.yml`).

- [ ] **Step 1: Add the blocking inputs to the reusable call**

In the `with:` block of the `uses: QNSC-VN/qnsc-ci/.github/workflows/security.yml@…` job, add:
```yaml
        with:
          product: rally          # existing
          semgrep_blocking: true
          osv_blocking: true
```
(For opshub, which runs Semgrep/osv inline rather than via the reusable, set the equivalent `--error` / non-zero-exit behavior in its inline job, or — preferred — migrate opshub to call the reusable `security.yml` so it inherits the phased inputs. If migrating, mirror rova's caller.)

- [ ] **Step 2: Open a PR and confirm the gate now fails ONLY on un-allowlisted findings**

Push a branch, open a PR, and check the Security run: Semgrep + osv now block, but the run is green because Task 2 allowlisted/fixed everything at or below the bar. If it fails, an un-triaged finding remains — return to Task 2.

- [ ] **Step 3: Commit / merge**

```bash
git add .github/workflows/backend-security.yml
git commit -m "ci(security): enforce Semgrep + osv (block on un-allowlisted findings)"
```

---

## Track B — Immutable pinning + Renovate

### Task 4: Pin caller repos to `qnsc-ci@v1.4.0`

**Prereq:** `qnsc-ci v1.4.0` exists (Wave 1 Task 5).
**Files (per repo):** every `.github/workflows/*.yml` that references `QNSC-VN/qnsc-ci/...@v1` (reusable workflows AND composite actions).

- [ ] **Step 1: Find the floating refs in a repo**

```bash
unset GITHUB_TOKEN GH_TOKEN
cd <repo-clone>
grep -rn 'QNSC-VN/qnsc-ci/[^@]*@v1\b' .github/workflows
```
Expected: lines like `uses: QNSC-VN/qnsc-ci/.github/workflows/backend-deploy.yml@v1`.

- [ ] **Step 2: Repin `@v1` → `@v1.4.0`**

```bash
sed -i -E 's#(QNSC-VN/qnsc-ci/[^@]+)@v1\b#\1@v1.4.0#g' .github/workflows/*.yml
grep -rn 'QNSC-VN/qnsc-ci/[^@]*@v1\b' .github/workflows && echo "STILL FLOATING" || echo "all pinned"
```
Expected: `all pinned`.

- [ ] **Step 3: Commit (per repo)**

```bash
git add .github/workflows
git commit -m "ci: pin qnsc-ci reusables/actions to immutable v1.4.0

Replaces floating @v1 (force-moved on every qnsc-ci push) with an immutable
tag for reproducible builds. Renovate manages future bumps (Task 5)."
```

### Task 5: Shared Renovate preset + per-repo enablement

**Files:**
- Create in `QNSC-VN/.github`: `renovate-config.json` (org default preset)
- Create in each product repo: `renovate.json`

- [ ] **Step 1: Confirm the Renovate GitHub App is installed on the org**

```bash
unset GITHUB_TOKEN GH_TOKEN
gh api /orgs/QNSC-VN/installations -q '.installations[].app_slug' 2>/dev/null | grep -i renovate \
  && echo "renovate installed" || echo "INSTALL Renovate app on the org first"
```
If not installed, install "Renovate" from the GitHub Marketplace onto QNSC-VN (admin action) before proceeding.

- [ ] **Step 2: Create the org preset** `renovate-config.json` in `QNSC-VN/.github`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":semanticCommits", ":dependencyDashboard"],
  "packageRules": [
    {
      "description": "Group QNSC-VN shared CI (reusables + composite actions) into one PR",
      "matchDepNames": ["/^QNSC-VN\\/qnsc-ci/"],
      "groupName": "qnsc-ci shared CI",
      "labels": ["ci", "shared"]
    },
    {
      "description": "Auto-merge patch bumps of pinned GitHub Actions once checks pass",
      "matchManagers": ["github-actions"],
      "matchUpdateTypes": ["patch"],
      "automerge": true
    }
  ],
  "prConcurrentLimit": 5,
  "schedule": ["before 9am on monday"]
}
```

- [ ] **Step 3: Enable Renovate per repo** — add `renovate.json` extending the org preset:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>QNSC-VN/.github:renovate-config"]
}
```

- [ ] **Step 4: Commit (org repo + each product repo)**

```bash
# in QNSC-VN/.github
git add renovate-config.json && git commit -m "chore(renovate): org-wide Renovate preset (group qnsc-ci, semantic commits)"
# in each product repo
git add renovate.json && git commit -m "chore(renovate): enable Renovate via org preset"
```

- [ ] **Step 5: Verify Renovate onboards + can bump qnsc-ci**

After merge, Renovate opens an onboarding/Dependency-Dashboard PR. Confirm the `github-actions` manager detects `QNSC-VN/qnsc-ci/...@v1.4.0` and will raise a PR when `v1.5.0` ships. Expected: a Renovate PR or dashboard issue appears within the schedule window.

---

## Success criteria

- Semgrep + osv **block** on un-allowlisted (HIGH+/fixable) findings; accepted findings live in committed, justified `.semgrepignore` / `osv-scanner.toml`.
- Every active repo pins `qnsc-ci@v1.4.0` — no floating `@v1`; builds are reproducible.
- Renovate is installed, uses the org preset, groups qnsc-ci bumps into reviewed PRs, and auto-merges green patch action bumps.

## Self-review notes

- **Spec coverage:** W2.1 (phased scan blocking) → Tasks 1–3; W2.2 (immutable pin + Renovate) → Tasks 4–5. Complete.
- **HIGH+ gating** is achieved via triage/allowlist (accept ≤ bar, leave HIGH+ to block) rather than a severity flag, because osv-scanner v1 has no severity threshold and Semgrep pack severities vary — this avoids a further qnsc-ci change. If a hard severity flag is later wanted, add `--severity=ERROR` to the reusable's Semgrep step (separate qnsc-ci change).
- **opshub** runs scans inline (not via the reusable); Task 3 Step 1 notes the preferred fix is migrating it to call `security.yml` so it inherits the phased inputs — otherwise replicate the blocking behavior inline.
- **Dependency on v1.4.0:** Track B is gated on Wave 1's release tag; Track A is independent and can ship first.
- No unit tests — CI-config changes; verification is the Security run result + Renovate onboarding.

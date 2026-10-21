# Release/CD Hardening — Wave 0 (Unblock Releases) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make merging a Release PR actually deploy — fix the release-tag→deploy mismatch in the canonical monorepos and repair the broken/ inconsistent merge gates.

**Architecture:** Two classes of change. (a) **Repo config** — a one-line `release-please-config.json` edit in `rova` and `opshub` so tags are `vX.Y.Z` instead of `rally-apivX.Y.Z`, matching the deploy trigger glob. (b) **Repo settings** — align each ruleset's required Gitleaks status context to the name the workflow actually emits, and enable branch auto-delete. Config changes ship as PRs; settings changes are applied by an org admin via `gh api` (they cannot run in restricted automation).

**Tech Stack:** release-please (node), GitHub Actions, GitHub repository rulesets, `gh` CLI.

**Reference spec:** `docs/superpowers/specs/2026-07-13-release-cd-hardening-design.md` (Wave 0).

**Preconditions:**
- `gh` authenticated as an org admin. Every `gh`/`git` command runs after `unset GITHUB_TOKEN GH_TOKEN` (an invalid env token otherwise shadows the working keyring token).
- No release tags exist org-wide yet (verified during audit) → no tag-history migration needed.

---

## Task 1: Fix release tag format in `rova` (config PR)

**Files:**
- Modify: `release-please-config.json` (repo root, in a fresh branch off `origin/main`)

- [ ] **Step 1: Branch off latest main**

```bash
unset GITHUB_TOKEN GH_TOKEN
cd /home/nghiavt18/personal/qnsc/rova
git fetch origin main
git checkout -B fix/release-tag-format origin/main
```

- [ ] **Step 2: Capture the current (buggy) computed tag for the record**

Run:
```bash
grep -E 'package-name|include-v-in-tag|include-component-in-tag|tag-separator' release-please-config.json
```
Expected: shows `"package-name": "rally-api"`, `"include-v-in-tag": true`, `"tag-separator": ""`, and **no** `include-component-in-tag` key → current tag = `rally-apivX.Y.Z`.

- [ ] **Step 3: Add `include-component-in-tag: false`**

In `release-please-config.json`, inside the `"."` package object (same level as `"package-name"`), add the key. Result region:

```json
    ".": {
      "release-type": "node",
      "package-name": "rally-api",
      "include-component-in-tag": false,
      "changelog-path": "CHANGELOG.md",
```

(Leave `include-v-in-tag: true` and `tag-separator: ""` as-is — with the component removed the tag becomes `vX.Y.Z`.)

- [ ] **Step 4: Verify the computed tag via release-please dry-run**

Run:
```bash
npx --yes release-please@16 release-pr \
  --repo-url=QNSC-VN/rova --target-branch=main --dry-run \
  --token="$(gh auth token)" 2>&1 | grep -iE 'tag|version' | head
```
Expected: the proposed tag / release is `v0.2.0` (NOT `rally-apiv0.2.0`). If the dry-run cannot run in the environment, fall back to Step 4b.

- [ ] **Step 4b (fallback verification): assert config shape**

Run:
```bash
node -e "const c=require('./release-please-config.json').packages['.']; if(c['include-component-in-tag']!==false) process.exit(1); console.log('component-in-tag disabled → tag = v<version>')"
```
Expected: prints the confirmation line, exit 0.

- [ ] **Step 5: Commit**

```bash
git add release-please-config.json
git commit -m "fix(release): emit vX.Y.Z tags so Release PR triggers deploy

release-please cut rally-apivX.Y.Z (component prefix), but backend/web
deploy trigger only on v[0-9]+.[0-9]+.[0-9]+, so merging the Release PR
never deployed. Disable include-component-in-tag → tag = vX.Y.Z."
```

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin fix/release-tag-format
gh pr create --base main --head fix/release-tag-format \
  --title "fix(release): emit vX.Y.Z tags so Release PR triggers deploy" \
  --body "Disables include-component-in-tag in release-please-config so the cut tag is \`vX.Y.Z\` (matches the deploy trigger glob \`v[0-9]+.[0-9]+.[0-9]+\`). Without this, merging the Release PR produces \`rally-apivX.Y.Z\` which never triggers backend/web deploy. No tags exist yet, so no history migration."
```
Expected: PR URL printed.

- [ ] **Step 7: Post-merge verification (record as PR checklist, done after merge)**

After this PR merges to main, the Release workflow re-runs and updates the open Release PR. Confirm its changelog compare link reads `…/compare/v0.1.0...v0.2.0` (not `rally-apiv…`). This is the definitive proof the tag is now `vX.Y.Z`.

---

## Task 2: Fix release tag format in `opshub` (config PR)

`opshub` is a separate repo not checked out locally. Same fix as Task 1.

**Files:**
- Modify: `release-please-config.json` in `QNSC-VN/opshub`

- [ ] **Step 1: Clone opshub to a scratch dir**

```bash
unset GITHUB_TOKEN GH_TOKEN
cd /tmp/claude-1000/-home-nghiavt18-personal-qnsc/3832ace1-fc90-46c9-9e2b-851fa28222eb/scratchpad
gh repo clone QNSC-VN/opshub -- --depth 1
cd opshub
```

- [ ] **Step 2: Confirm the same bug shape**

Run:
```bash
grep -E 'package-name|include-v-in-tag|include-component-in-tag|tag-separator' release-please-config.json
```
Expected: `"package-name": "opshub-api"`, `include-v-in-tag: true`, `tag-separator: ""`, no `include-component-in-tag` → tag = `opshub-apivX.Y.Z`.

- [ ] **Step 3: Add `include-component-in-tag: false`**

In the `"."` package object, add `"include-component-in-tag": false` next to `"package-name"` (mirror Task 1 Step 3).

- [ ] **Step 4: Verify config shape**

Run:
```bash
node -e "const c=require('./release-please-config.json').packages['.']; if(c['include-component-in-tag']!==false) process.exit(1); console.log('opshub tag → v<version>')"
```
Expected: prints confirmation, exit 0.

- [ ] **Step 5: Commit, push, PR**

```bash
git checkout -B fix/release-tag-format
git add release-please-config.json
git commit -m "fix(release): emit vX.Y.Z tags so Release PR triggers deploy

opshub-apivX.Y.Z never matched the deploy glob v[0-9]+.[0-9]+.[0-9]+.
Disable include-component-in-tag → tag = vX.Y.Z."
git push -u origin fix/release-tag-format
gh pr create --base main --head fix/release-tag-format \
  --title "fix(release): emit vX.Y.Z tags so Release PR triggers deploy" \
  --body "Same fix as rova: disable include-component-in-tag so the release tag is \`vX.Y.Z\`, matching the deploy trigger. No tags exist yet."
```
Expected: PR URL printed.

---

## Task 3: Align Gitleaks ruleset contexts (settings — org admin runs)

Rulesets must require the status context the workflow **emits**: bare
`Secret scan (Gitleaks)` for repos running Gitleaks as an inline job,
`security / Secret scan (Gitleaks)` for repos calling the reusable under a job
named `security`. This task fixes the two confirmed-broken repos.

**Repos/rulesets (from audit):** `opshub` ruleset requires the prefixed name but
emits bare; `qnsc-infra` same. `rova` already consistent (leave it).

- [ ] **Step 1: Verify the mismatch per repo before changing anything**

For each of `opshub`, `qnsc-infra`:
```bash
unset GITHUB_TOKEN GH_TOKEN
repo=opshub   # then repeat with qnsc-infra
# a) what the ruleset requires:
for id in $(gh api repos/QNSC-VN/$repo/rulesets -q '.[].id'); do
  gh api repos/QNSC-VN/$repo/rulesets/$id \
    -q '.rules[]?|select(.type=="required_status_checks").parameters.required_status_checks[].context'
done
# b) what a recent run actually emitted:
gh api "repos/QNSC-VN/$repo/commits/HEAD/check-runs" -q '.check_runs[].name' | grep -i gitleaks
```
Expected: (a) prints `security / Secret scan (Gitleaks)`; (b) prints `Secret scan (Gitleaks)` (no prefix) → confirms mismatch.

- [ ] **Step 2: Patch the ruleset to require the emitted (bare) context**

For each confirmed repo+ruleset id (`REPO`, `RID`):
```bash
unset GITHUB_TOKEN GH_TOKEN
gh api "repos/QNSC-VN/$REPO/rulesets/$RID" \
| jq '{name,enforcement,bypass_actors,conditions,rules}
      | (.rules[]|select(.type=="required_status_checks").parameters.required_status_checks[]
         |select(.context=="security / Secret scan (Gitleaks)").context)
        |= "Secret scan (Gitleaks)"' \
| gh api -X PUT "repos/QNSC-VN/$REPO/rulesets/$RID" --input -
```
Expected: API returns the updated ruleset (HTTP 200).

- [ ] **Step 3: Verify the fix**

```bash
gh api "repos/QNSC-VN/$REPO/rulesets/$RID" \
  -q '.rules[]?|select(.type=="required_status_checks").parameters.required_status_checks[].context'
```
Expected: now lists `Secret scan (Gitleaks)` (bare) — matches the emitted check. Re-run the scan on an open PR (or push) and confirm the check reports and the "waiting for status" state clears.

> NOTE: This step edits branch protection and cannot run in restricted automation.
> An org admin runs it, or approves the exact commands above.

---

## Task 4: Enable branch auto-delete org-wide (settings — org admin runs)

- [ ] **Step 1: List active repos (exclude archived/legacy split repos)**

```bash
unset GITHUB_TOKEN GH_TOKEN
gh repo list QNSC-VN --no-archived --limit 100 --json name,isArchived -q '.[].name'
```
Expected: prints active repo names.

- [ ] **Step 2: Enable delete_branch_on_merge on each active repo**

```bash
unset GITHUB_TOKEN GH_TOKEN
for repo in rova opshub qnsc-ci qnsc-app-platform qnsc-landing qnsc-infra qnsc-infra-template ceo-suite; do
  gh api -X PATCH "repos/QNSC-VN/$repo" -F delete_branch_on_merge=true >/dev/null \
    && echo "enabled: $repo"
done
```
Expected: `enabled: <repo>` per repo.

- [ ] **Step 3: Verify**

```bash
for repo in rova opshub qnsc-ci qnsc-app-platform qnsc-landing; do
  echo "$repo: $(gh api repos/QNSC-VN/$repo -q .delete_branch_on_merge)"
done
```
Expected: each prints `true`.

> NOTE: Repo-settings write — org admin runs or approves.

---

## Task 5: Cut a real release to validate the end-to-end flow

Once Tasks 1–2 are merged, prove the whole chain works.

- [ ] **Step 1: Merge the open Release PR in `rova`**

Confirm PR #8 (`chore(release): 0.2.0`) shows a `v0.1.0...v0.2.0` compare link (proves Task 1). Merge it.

- [ ] **Step 2: Verify the tag + release + downstream triggers**

```bash
unset GITHUB_TOKEN GH_TOKEN
gh release list --repo QNSC-VN/rova | head        # expect v0.2.0
gh run list --repo QNSC-VN/rova --workflow=backend-deploy.yml --limit 3   # expect a run triggered by the tag
```
Expected: a `v0.2.0` GitHub Release exists AND `backend-deploy` (+ web-deploy) ran on the tag. Prod deploy pauses at the `production` Environment approval gate.

- [ ] **Step 3: Confirm release commenter + branch-delete**

Check that a PR merged since 0.1.0 received a `released: v0.2.0` back-comment/label, and that merged feature branches were auto-deleted (Task 4).

---

## Self-review notes

- **Spec coverage:** W0.1 → Tasks 1–2; W0.2 → Task 3; W0.3 → Task 4; end-to-end success criteria → Task 5. Complete for Wave 0.
- **Not TDD-shaped:** these are config/settings changes; each task pairs the change with an explicit verification command instead of a unit test (appropriate — there is no application code under test).
- **Waves 1–2** are separate plans (qnsc-ci reusable hardening; supply-chain posture), authored after Wave 0 merges and a `qnsc-ci v1.4.0` baseline exists.
- **Settings tasks (3, 4)** cannot run in restricted automation — flagged for an org admin to run or approve.

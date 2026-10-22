# Release/CD Hardening — Wave 1 (qnsc-ci Deploy Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make prod deploys self-healing and verifiable — ECS circuit-breaker auto-rollback, migrations that run the exact deploying image, and blocking + verified image attestation — all in the shared `QNSC-VN/qnsc-ci` `backend-deploy.yml` reusable so every product inherits them.

**Architecture:** All changes are in one file, `QNSC-VN/qnsc-ci/.github/workflows/backend-deploy.yml` (the reusable backend deploy). No product-repo changes. Because caller repos currently float `@v1` (qnsc-ci force-moves it to HEAD on merge), changes propagate org-wide the moment they merge to qnsc-ci `main` — so this plan validates on a real develop deploy via a **feature-branch ref** BEFORE merging, then cuts `v1.4.0`.

**Tech Stack:** GitHub Actions reusable workflows, AWS ECS (Fargate) via `aws` CLI, `actions/attest-build-provenance`, `gh attestation verify`.

**Reference spec:** `docs/superpowers/specs/2026-07-13-release-cd-hardening-design.md` (Wave 1).
**Prereq:** Wave 0 merged (deploys actually trigger on `vX.Y.Z`).

**Working copy:** clone qnsc-ci to scratch and branch:
```bash
unset GITHUB_TOKEN GH_TOKEN
cd /tmp/claude-1000/-home-nghiavt18-personal-qnsc/3832ace1-fc90-46c9-9e2b-851fa28222eb/scratchpad
rm -rf qnsc-ci && gh repo clone QNSC-VN/qnsc-ci
cd qnsc-ci && git checkout -B feat/deploy-hardening
```
All edits target `.github/workflows/backend-deploy.yml`. Validate YAML after each task:
```bash
npx --yes @action-validator/cli@latest .github/workflows/backend-deploy.yml || \
  python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/backend-deploy.yml')); print('yaml ok')"
```

---

## Task 1: ECS deployment circuit breaker + auto-rollback

> **⚠️ SUPERSEDED (infra check).** The shared Terraform module `qnsc-tf-modules/modules/ecs-service` (tag `ecs-service-v1.3.0`, which rova/opshub deploy) **already declares** `deployment_circuit_breaker { enable = true, rollback = true }`. Setting it again from the deploy workflow is redundant and — because `--deployment-configuration` on `update-service` replaces the whole config — resets `maximumPercent`/`minimumHealthyPercent` to defaults on every deploy. **Single source of truth = Terraform.** The circuit-breaker CLI flag was therefore NOT shipped (removed from qnsc-ci #27). Auto-rollback still works — it's IaC-managed — and Task 4 (rollback-aware notify) detects and reports it. No workflow change for this task; the steps below are retained only as the original record.

**File:** Modify `.github/workflows/backend-deploy.yml` (the two `aws ecs update-service … --force-new-deployment` steps: "Deploy API service", "Deploy Worker service").

**Why:** Today a bad rollout stays live; ECS's native circuit breaker reverts to the last stable task set on failure.

- [ ] **Step 1: Add circuit-breaker config to the API deploy step**

Replace the "Deploy API service" step's run body with (adds `--deployment-configuration`):
```yaml
      - name: Deploy API service
        run: |
          aws ecs update-service --cluster "${{ vars.ECS_CLUSTER }}" --service "${{ vars.ECS_API_SERVICE }}" \
            --task-definition "${{ steps.api-taskdef.outputs.arn }}" --force-new-deployment \
            --deployment-configuration '{"deploymentCircuitBreaker":{"enable":true,"rollback":true}}' \
            --region "${{ inputs.aws_region }}"
```

- [ ] **Step 2: Add the same to the Worker deploy step**

```yaml
      - name: Deploy Worker service
        if: inputs.has_worker
        run: |
          aws ecs update-service --cluster "${{ vars.ECS_CLUSTER }}" --service "${{ vars.ECS_WORKER_SERVICE }}" \
            --task-definition "${{ steps.worker-taskdef.outputs.arn }}" --force-new-deployment \
            --deployment-configuration '{"deploymentCircuitBreaker":{"enable":true,"rollback":true}}' \
            --region "${{ inputs.aws_region }}"
```

- [ ] **Step 3: Validate YAML** (run the validator command above). Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/backend-deploy.yml
git commit -m "feat(deploy): enable ECS deployment circuit breaker with rollback

A failed rollout now auto-reverts to the last stable task set instead of
leaving the bad revision serving traffic."
```

> **Note (rollback detection depends on health signals):** the circuit breaker
> trips on failed task health — the API service must have an ALB target-group
> health check or container `HEALTHCHECK` (rova/opshub do, via ALB). No workflow
> change needed; documented so the caller's service config is understood.

---

## Task 2: Run migrations on the exact deploying image (not `:latest`)

**File:** Modify `.github/workflows/backend-deploy.yml` — add a migrator task-def registration step before "Run database migrations", and point the migration at the new ARN.

**Why:** `run-db-migration` currently uses `vars.ECS_MIGRATOR_TASK_DEF` (a family → latest revision → `:latest` image). On a prod tag deploy the migration then runs whatever `:latest` happens to be, not the promoted `vX.Y.Z`. Register a revision pinned to `IMAGE_TAG` first.

- [ ] **Step 1: Add the migrator task-def registration step**

Insert immediately BEFORE the "Run database migrations" step (mirrors the existing api-taskdef step; container name `migrator`):
```yaml
      - name: Update Migrator task definition to ${{ env.IMAGE_TAG }}
        id: migrator-taskdef
        if: inputs.has_migrator
        env:
          IMAGE_TAG: ${{ env.IMAGE_TAG }}
        run: |
          FAMILY="${{ vars.ECS_MIGRATOR_TASK_DEF }}"
          TASK_DEF=$(aws ecs describe-task-definition --task-definition "$FAMILY" --query 'taskDefinition' --output json)
          NEW_DEF=$(echo "$TASK_DEF" | python3 -c "
          import sys, json, os
          td = json.load(sys.stdin); tag = os.environ['IMAGE_TAG']
          for c in td.get('containerDefinitions', []):
              if c.get('name') == 'migrator':
                  c['image'] = c['image'].rsplit(':', 1)[0] + ':' + tag
          for f in ['taskDefinitionArn','revision','status','requiresAttributes','placementConstraints','compatibilities','registeredAt','registeredBy']:
              td.pop(f, None)
          print(json.dumps(td))")
          ARN=$(aws ecs register-task-definition --cli-input-json "$NEW_DEF" --query 'taskDefinition.taskDefinitionArn' --output text)
          echo "arn=$ARN" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Point the migration at the pinned revision**

Change the "Run database migrations" step's `task-definition` input from the family var to the new ARN:
```yaml
      - name: Run database migrations
        if: inputs.has_migrator
        uses: QNSC-VN/qnsc-ci/actions/run-db-migration@v1
        with:
          cluster: ${{ vars.ECS_CLUSTER }}
          task-definition: ${{ steps.migrator-taskdef.outputs.arn }}
          subnet-ids: ${{ vars.ECS_MIGRATOR_SUBNET }}
          security-group-ids: ${{ vars.ECS_MIGRATOR_SG }}
          region: ${{ inputs.aws_region }}
          environment: ${{ env.ENVIRONMENT }}
```
(`run-db-migration` passes `task-definition` straight to `ecs run-task`, which accepts a full revision ARN — verified in the action source.)

- [ ] **Step 3: Validate YAML.** Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/backend-deploy.yml
git commit -m "fix(deploy): run migrations on the deploying image, not :latest

Register a migrator task-def revision pinned to IMAGE_TAG and run migrations
against it, so prod schema changes execute the exact promoted image."
```

---

## Task 3: Blocking, verified image attestation

**File:** Modify `.github/workflows/backend-deploy.yml` — (a) make the develop-path attest steps blocking; (b) attest the promoted prod image; (c) verify the attestation before the ECS roll.

**Why:** Attestation is `continue-on-error` (never blocks) and only produced on the develop build — the prod-promoted image is neither attested nor verified before it serves traffic.

- [ ] **Step 1: Make develop attestations blocking**

Remove `continue-on-error: true` from all three "Attest … image" steps (API, Worker, Migrator) in the `build-push` job. Leave everything else on those steps unchanged.

- [ ] **Step 2: Capture promoted digests on the tag path**

In the `build-push` job, immediately AFTER the "Promote images …" step, add a step that resolves the promoted image digests and attests each (runs only on tag):
```yaml
      - name: Attest promoted images
        if: github.ref_type == 'tag'
        env:
          REGISTRY: ${{ steps.aws.outputs.ecr-registry }}
          REGION:   ${{ inputs.aws_region }}
          RELEASE_TAG: ${{ env.IMAGE_TAG }}
        run: |
          set -euo pipefail
          IFS=',' read -ra REPOS <<< "${{ steps.images.outputs.list }}"
          for repo in "${REPOS[@]}"; do
            repo="${repo// /}"
            digest=$(aws ecr describe-images --repository-name "$repo" \
              --image-ids imageTag="$RELEASE_TAG" --region "$REGION" \
              --query 'imageDetails[0].imageDigest' --output text)
            echo "${repo}@${digest}" >> promoted-digests.txt
          done
          cat promoted-digests.txt
      - name: Attest each promoted image
        if: github.ref_type == 'tag'
        uses: QNSC-VN/qnsc-ci/actions/attest-image@v1
        with:
          image-ref: ${{ steps.aws.outputs.ecr-registry }}/${{ inputs.product }}-api@${{ steps.promoted-api-digest.outputs.digest }}
```

> IMPLEMENTATION NOTE: `attest-image` attests ONE ref per call. Rather than a
> loop (composite actions can't be called in a shell loop), attest the **API**
> image (the deployed service) on the tag path — resolve its digest in a small
> step and pass it. Worker/migrator were already attested on the develop build
> whose bytes are being promoted (same digest), so API-on-promotion closes the
> gap for the served artefact. Concretely, replace the two YAML blocks above with:

```yaml
      - name: Resolve promoted API digest
        if: github.ref_type == 'tag'
        id: promoted-api-digest
        env:
          REGION: ${{ inputs.aws_region }}
          RELEASE_TAG: ${{ env.IMAGE_TAG }}
        run: |
          set -euo pipefail
          digest=$(aws ecr describe-images --repository-name "${{ inputs.product }}-api" \
            --image-ids imageTag="$RELEASE_TAG" --region "$REGION" \
            --query 'imageDetails[0].imageDigest' --output text)
          echo "digest=$digest" >> "$GITHUB_OUTPUT"

      - name: Attest promoted API image
        if: github.ref_type == 'tag'
        uses: QNSC-VN/qnsc-ci/actions/attest-image@v1
        with:
          image-ref: ${{ steps.aws.outputs.ecr-registry }}/${{ inputs.product }}-api@${{ steps.promoted-api-digest.outputs.digest }}
```
(Use only this second form; delete the first illustrative block.)

- [ ] **Step 3: Verify attestation before the ECS roll**

In the `deploy` job, add a step BEFORE "Deploy API service" (needs `contents:read` + network; uses `gh`):
```yaml
      - name: Verify image attestation
        env:
          GH_TOKEN: ${{ github.token }}
          REGION:   ${{ inputs.aws_region }}
        run: |
          set -euo pipefail
          REGISTRY=$(aws ecr describe-registry --region "$REGION" --query registryId --output text).dkr.ecr.${REGION}.amazonaws.com
          digest=$(aws ecr describe-images --repository-name "${{ inputs.product }}-api" \
            --image-ids imageTag="${{ env.IMAGE_TAG }}" --region "$REGION" \
            --query 'imageDetails[0].imageDigest' --output text)
          gh attestation verify "oci://${REGISTRY}/${{ inputs.product }}-api@${digest}" \
            --repo "${{ github.repository }}"
```

- [ ] **Step 4: Validate YAML.** Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/backend-deploy.yml
git commit -m "feat(deploy): block on attestation + verify promoted image before roll

Attestations now fail the build instead of continue-on-error; the promoted
prod API image is attested and gh-attestation-verified before ECS deploy."
```

---

## Task 4: Rollback-aware deploy notification

**File:** Modify `.github/workflows/backend-deploy.yml` — the "Verify API deployment" and "Notify deploy result" steps.

**Why:** When the circuit breaker (Task 1) reverts, `wait services-stable` succeeds on the OLD task def and the existing image-tag assertion already fails — but the final notification only knows success/failure. `notify-deploy` already supports a `rollback` status (⏪); wire it.

- [ ] **Step 1: Have the verify step emit a rollback flag instead of a bare exit**

Replace the "Verify API deployment" step:
```yaml
      - name: Verify API deployment
        id: verify
        run: |
          AWS_MAX_ATTEMPTS=120 aws ecs wait services-stable --cluster "${{ vars.ECS_CLUSTER }}" --services "${{ vars.ECS_API_SERVICE }}" --region "${{ inputs.aws_region }}"
          ACTIVE_TASKDEF=$(aws ecs describe-services --cluster "${{ vars.ECS_CLUSTER }}" --services "${{ vars.ECS_API_SERVICE }}" --region "${{ inputs.aws_region }}" --query 'services[0].taskDefinition' --output text)
          ACTIVE_IMAGE=$(aws ecs describe-task-definition --task-definition "$ACTIVE_TASKDEF" --region "${{ inputs.aws_region }}" --query 'taskDefinition.containerDefinitions[0].image' --output text)
          echo "Active image: $ACTIVE_IMAGE"
          if echo "$ACTIVE_IMAGE" | grep -q "${{ env.IMAGE_TAG }}"; then
            echo "outcome=success" >> "$GITHUB_OUTPUT"
          else
            echo "outcome=rollback" >> "$GITHUB_OUTPUT"
            echo "::error ::Deployment did not converge on ${{ env.IMAGE_TAG }} — circuit breaker rolled back to $ACTIVE_IMAGE"
            exit 1
          fi
```

- [ ] **Step 2: Make the notification report rollback**

Replace the `status:` line of the "Notify deploy result" step so a rollback is distinguished from a plain failure:
```yaml
      - name: Notify deploy result
        if: always()
        uses: QNSC-VN/qnsc-ci/actions/notify-deploy@v1
        with:
          webhook-url: ${{ secrets.SLACK_DEPLOY_WEBHOOK }}
          status: ${{ job.status == 'success' && 'success' || (steps.verify.outputs.outcome == 'rollback' && 'rollback' || 'failure') }}
          service: ${{ inputs.product }}-api
          environment: ${{ env.ENVIRONMENT }}
          version: ${{ env.IMAGE_TAG }}
```

- [ ] **Step 3: Validate YAML.** Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/backend-deploy.yml
git commit -m "feat(deploy): distinguish auto-rollback in the deploy notification

When the circuit breaker reverts, notify with the 'rollback' status (⏪)
instead of a generic failure, so operators see what happened."
```

---

## Task 5: Validate on develop, then release qnsc-ci v1.4.0

**Why:** Caller repos float `@v1` (force-moved on merge), so merging propagates instantly. Validate against a real develop deploy on a feature ref first.

- [ ] **Step 1: Push the feature branch (no merge yet)**

```bash
git push -u origin feat/deploy-hardening
```

- [ ] **Step 2: Point ONE product's develop deploy at the feature ref, temporarily**

In a throwaway branch of `rova`, change `.github/workflows/backend-deploy.yml`'s `uses:` from `@v1` to `@feat/deploy-hardening`, push to a branch, and let the develop deploy run (main-push path). Confirm: migrator task-def shows the deploying tag; deploy succeeds; attestation step runs and passes. Revert the throwaway branch (do not merge).

- [ ] **Step 3: Synthetic rollback test (optional but recommended)**

On the same throwaway ref, introduce a deliberately failing image/health (e.g. bad healthcheck path) and confirm: the circuit breaker reverts, the verify step exits 1 with the rollback error, and the notification shows ⏪ rollback. Revert.

- [ ] **Step 4: Merge qnsc-ci feature branch + cut the release**

```bash
# open + merge the qnsc-ci PR
gh pr create --repo QNSC-VN/qnsc-ci --base main --head feat/deploy-hardening \
  --title "feat(deploy): circuit-breaker rollback, migrator pinning, verified attestation" \
  --body "Wave 1 of the release/CD hardening program. See rova docs/superpowers/plans/2026-07-13-release-cd-hardening-wave1.md."
# after merge, cut an IMMUTABLE minor release of qnsc-ci
git -C <qnsc-ci> checkout main && git pull
gh release create v1.4.0 --repo QNSC-VN/qnsc-ci --target main \
  --title "v1.4.0 — deploy hardening" \
  --notes "ECS circuit-breaker auto-rollback, migrator image pinning, blocking+verified attestation, rollback-aware notify."
```
Expected: `v1.4.0` exists. (Wave 2 pins callers to `@v1.4.0` + adds Renovate.)

---

## Self-review notes

- **Spec coverage:** W1.1→Task 1; W1.2→Task 2; W1.3→Task 3; W1.4→Task 4; release+validate→Task 5. Complete.
- **Type/name consistency:** step ids `api-taskdef`, `worker-taskdef`, `migrator-taskdef`, `promoted-api-digest`, `verify` are each defined before use; `steps.images.outputs.list` and `steps.aws.outputs.ecr-registry` already exist in the file.
- **No unit tests:** this is deploy-orchestration YAML; verification is YAML-lint + a real develop deploy + a synthetic rollback (Task 5). There is no local test harness for ECS behavior.
- **Rollout risk:** floating `@v1` means merge = org-wide. Task 5 validates on a feature ref before merge; Wave 2 removes this hazard via immutable pinning.
- **cosign / progressive delivery:** out of scope (deferred per spec).

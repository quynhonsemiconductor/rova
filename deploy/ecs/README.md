# deploy/ecs — ECS deploy descriptors

Rova's ECS **task definitions are infrastructure-owned**, not stored as standalone JSON templates here. This is deliberate and matches the OpenTofu↔deploy boundary in [TECH_STACK.md §3](https://github.com/quynhonsemiconductor/.github/blob/main/docs/TECH_STACK.md):

- **Baseline task definitions + services** are created by the `ecs-service` module, called as `module "api"` and `module "worker"` in [`infra/modules/stack/main.tf`](../../infra/modules/stack/main.tf) (family, CPU/mem, IAM task role, secrets, ALB target group, autoscaling).
- **CI patches only the image** on each deploy: `aws ecs describe-task-definition` → swap the container image tag → `aws ecs register-task-definition` (new revision) → `aws ecs update-service`. See `.github/workflows/` (via `quynhonsemiconductor/ci`).
- The **migrator** one-off task def is `module "migrator"` (the shared `oneshot-task` module) in that same stack module, run as an ECS `run-task` gate before the API rolls out.

[`infra/live/<env>/main.tf`](../../infra/live) holds **values, never resources** — one `module "stack"` call per environment. That is why the paths above point at the module rather than at an environment: an environment file cannot change the shape of a task definition, only what is fed into it.

So there is no task-def template to maintain here — OpenTofu owns the shape, CI owns the image tag. This file documents that contract.

## The half of the contract that surprises people

`ecs-service` sets `ignore_changes = [task_definition]`, so **Terraform registering a revision is not a deploy.** An `infra/**` change that alters task-definition environment or secrets applies cleanly, produces a correct new revision, and changes nothing running until the deploy pipeline moves the service onto it. Both deploy workflows therefore keep `infra/**` OUT of `paths-ignore` and gate on `wait-for-infra` for the same sha. Re-adding it recreates a silent failure where the apply succeeds, the new definition is correct, nothing rolls, and the old value stays live.

For the same reason the service is **not** rolled from `infra-apply`: Terraform's newest task definition already carries a new image, so rolling it there would ship application code ahead of `Run database migrations`.

**At the EKS phase** (architecture §13.2, trigger-driven) this directory is replaced by a Helm `chart/`, and CD moves from push (`update-service`) to pull (ArgoCD).

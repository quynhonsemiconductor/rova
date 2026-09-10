# Contributing

## Branching: trunk-based by default

Branch from `main`, open a PR against `main`, merge within a day or two. `main` is the only
long-lived branch.

For a multi-part feature, **merge each part to `main` before starting the next** rather than
holding a chain of branches open. If a part is not ready to be seen, ship it unrouted or behind
a flag — an incomplete feature on `main` is cheaper than a stack of open PRs.

Why this is the default: a chain of open PRs drifts from `main` the moment anything merges, and
every branch in it has to be rebuilt when the branch below it lands. Phase 7 (#558–#590) held
eight PRs open for three days and paid for it twice — 40 commits of drift mid-stack, and 18
conflicting files the instant the bottom PR merged.

## Merging: squash only

`main` allows **squash merges only** (merge commits are disabled). One PR becomes one commit.

That commit's subject is the **PR title**, and release-please parses it, so:

- PR titles MUST be Conventional Commits — enforced by the `PR title (conventional commits)` check.
- Use a lowercase subject after the type: `feat(test-cases): add Test Result detail view`, not
  `feat(test-cases): Test Result detail view`.
- Write the title for someone reading the changelog. Describe the capability, not the internal
  plan step — `record and list Test Results`, never `phase D`.
- `feat` and `fix` are user-visible in `CHANGELOG.md`; `chore`, `ci`, `docs` and `test` are hidden.
  Pick the type that matches what a reader should see.

While the version is below `1.0.0`, `feat` bumps the patch, not the minor.

## Stacked PRs: the exception, and the rules

Prefer trunk-based. Stack only when a part genuinely cannot merge yet (for example its parent is
blocked in review).

If you stack:

1. **Three PRs deep, maximum.**
2. **Maintain it with `rebase`, never `merge`.** This is not a style preference. Squash-merging the
   parent replaces its commits with one new SHA; a child that still carries the parent's original
   commits will try to re-apply content `main` already has, and conflict on every file both
   touched. Restack the whole chain in one command:
   ```bash
   git rebase --update-refs --onto origin/main <old-parent-tip> <top-branch>
   ```
   `<old-parent-tip>` is the parent's head **at the moment it merged** — the async merge API
   returns it as `expected_head_sha`. Rebasing onto `origin/main` without that boundary replays
   the parent's commits too, which is what produces the conflicts you are trying to avoid.
3. **Restack immediately after each merge**, before requesting review again.
4. **Only the PR author pushes.** `require_last_push_approval` means the last pusher cannot be the
   approver, and GitHub will not let an author approve their own PR — so if a reviewer force-pushes
   a stack branch, nobody is left who can approve it.
5. Note that rulesets protect `main` only. A PR targeting an intermediate branch faces **no
   required checks and no required review**, so the gate you rely on is not running until the PR is
   retargeted to `main`.

## Before you push

```bash
pnpm typecheck                # backend
pnpm --filter rova-web exec tsc --noEmit
pnpm lint
pnpm test                     # vitest
```

CI runs these plus E2E, Docker build, migration upgrade path, OpenAPI contract diff, and the
security scans.

## The merge gate

`Backend CI required` and `Web CI required` are the checks that matter. Each asserts a positive
result from every job in its workflow, because GitHub counts a **skipped or cancelled** required
check as **passing** — so a job that never ran cannot be caught by requiring that job by name.

If a gate is red, read the `dependency results → …` line in its log; it names which job did not
succeed.

Two consequences worth internalising:

- A green checkmark count is not evidence. Phase 7's upper five PRs showed `5/5` green while the
  entire test suite, build, E2E, migration and security scans never started.
- Adding a job to a CI workflow means adding it to that workflow's `ci-required.needs`. A job
  outside `needs` is a job outside the gate.

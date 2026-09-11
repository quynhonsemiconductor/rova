# Tooling behaviour that surprises people

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

- **`pnpm db:migrate` also seeds.** It runs the tenant bootstrap seed, not just
  migrations. `pnpm db:seed` runs the full demo seed on top. Both are idempotent.
- **Migrations are hand-written.** `drizzle-kit generate` needs a TTY and cannot
  run unattended, so `db/migrations/*.sql` are authored by hand and must match
  `db/schema/*`. CI proves a new migration applies on top of `main`'s schema, not
  just a fresh database — see the `migrations` job in `backend-ci.yml`.

  **Applying a HIGHER-numbered migration first strands the lower one on that database, silently.**
  Drizzle records the journal's `when` as `created_at` and applies only entries past the newest
  recorded value, so if `0120` is applied while `0119` is still being written, `pnpm db:migrate`
  afterwards reports "Migrations applied" and `0119` never runs — its table simply does not exist.
  Fresh databases and CI are fine, because the journal's array order is still ascending; this bites the
  local database you are testing on, which is the one you would trust. Two ways in: writing two
  migrations in parallel (do not — one at a time, even across parallel work), or a `when` that is not
  strictly greater than its predecessor's. Verify with
  `select count(*) from drizzle.__drizzle_migrations` against the journal's entry count; recover by
  applying the stranded file by hand or recreating the database. (Two historical pairs — 0005/0006 and
  0018/0019 — have non-ascending `when` values and ARE applied, so a non-monotonic journal is not by
  itself proof of a skip; count the rows.)
- **`db/permissions.catalog.ts` is the single source of truth** for permission
  codes and role→permission mappings, imported via the `@db/*` path. It lives
  outside `libs/` because the standalone migrator image ships `db/**` only.
  `libs/shared-kernel/src/permissions.ts` re-exports it; two specs
  (`permissions.spec.ts`, `fe-permission-contract.spec.ts`) stop BE and FE drifting.
- **The built entrypoint is genuinely `dist/apps/api/apps/api/src/main.js`.** Nest
  emits one output tree whose common root is the repo root and rewrites path
  aliases to relative requires, so the nesting is what makes those resolve. Don't
  "fix" it — flattening breaks every emitted import.
- **Swagger is opt-in per environment.** `SWAGGER_ENABLED` (default `false`) serves
  `/api/docs`. It used to be derived from `NODE_ENV !== 'production'`, so anything
  not literally "production" published the endpoint inventory. CSP is now always on;
  the Swagger allowance is scoped to `scriptSrc` when that flag is set.
- **Coverage is a ratchet, not a target.** `vitest.config.ts` lists the files that
  have specs; `test/coverage-include.spec.ts` fails if a spec's subject is missing
  from that list or if the list names a deleted file. Raise the floors, never lower.
  **Re-measure when you raise them.** The floors sat ~11 points under real coverage for two phases
  (70/66/62/70 against 82/77/81/83), so a ten-point regression would have passed — a ratchet that
  trails that far measures nothing. Same for `fe-consistency.ratchet.test.ts`: four of its six
  baselines had drifted below their true counts, so 39 new violations could have landed green. Measure
  by forcing the baselines to `-1` and reading the counts the failures report — a grep alongside gets
  it wrong (mine said 8 for `text-[` where the real count is 2).
- **`ProjectScopeResolver`'s `work_item` kind spans TWO tables.** Tasks left `work_items` for
  `work.tasks` at the Phase 3 split (migration 0072), but the ROUTES did not split with them —
  `PATCH /work-items/:id`, `/:id/activity`, `/:id/attachments`, `/:id/watchers` and
  `PATCH /team-status/tasks/:taskId` all take a TASK's own id. The resolver mapped the kind to
  `work_items` alone, so the guard threw `WORK_ITEM_NOT_FOUND` for every task id before the handler
  ran, as a Workspace Admin, regardless of permission. A Task was uneditable everywhere, its Revision
  History permanently empty and its attachments unreachable — four Phase 1 contracts dead on one line
  of table mapping. It now falls back to `work.tasks` on a miss, mirroring
  `WorkItemDrizzleRepository.findById`, whose own docblock already described that fallback as what
  task surfaces depend on. **Adding a `task` resource kind would NOT have worked**: the routes are
  shared, so one kind has to cover both tables.
- **A spec that calls a service directly cannot see a guard defect.** Every task spec called
  `WorkItemsService` and the whole suite passed over the fault above for as long as it existed. Same
  blind spot that hid the `report:view` bug. `test/e2e/task-routes.e2e.spec.ts` and
  `report-authz.e2e.spec.ts` are the shape that catches it: real `AppModule`, `app.inject()`, a Bearer
  token from `AuthService.devLogin` (Bearer callers are CSRF-exempt by design, so no token dance).
- **A decorator-counting ratchet is not an authorization test.** `route-policy.ratchet.spec.ts` reads
  source text, so it cannot tell a correct `@RequirePermission` from a misspelled code or a
  project-tier code whose scope resolves from the wrong field. `test/e2e/report-authz.e2e.spec.ts` is
  the shape that does: real `AppModule`, `app.inject()`, both directions. Three things it had to learn
  the hard way — the test app has **no `/v1` prefix** and **no cookie plugin** (`reply.setCookie is
not a function`, so use `AuthService.devLogin` for a bearer token), the **ValidationPipe runs before
  the guard** (an incomplete query is a 400 and never reaches authorization), and a JIT-provisioned SSO
  user is **not** a denied principal — `assignDefaultRole` grants `project_member`, which the BA gives
  `report:view`. Use a seeded user with custom roles for the negative case.
- **The grids are DIVs, so `aria-sort` and `role="columnheader"` are deliberately absent.** They are
  only meaningful on a real `columnheader`, and `DataTableFrame` renders a scroll container while each
  page renders its own rows — adding the role to the header alone would announce a one-row table,
  which is worse than no table semantics. `SortHeader` carries the state in its accessible name
  instead ("Rank, sorted ascending. Activate to sort."), which is true regardless of the surrounding
  structure. It is also a real `<button>` now: it was a `div` with `onClick`, so sorting — a
  documented feature on every grid in the app — was pointer-only.
- **Rank reorder needs a KEYBOARD sensor AND a focusable grip — both, or neither works.**
  `KeyboardSensor` appeared nowhere in the SPA, and `DragHandle` was a `div`, so reorder was
  pointer-only on Backlog, Iteration Status, Quality and Portfolio. Adding the sensor alone would not
  have helped: dnd-kit activates from the ACTIVATOR's `onKeyDown`, and dnd-kit's `attributes` (which
  carry `role="button"` and `tabIndex`) were spread on the ROW while `listeners` were on the grip — so
  focus landed on one node and the key handler lived on another. `attributes` now go on the grip
  alongside `listeners` (which also stops every row announcing as a button with its own tab stop), and
  `useRerankSensors()` is the one shared sensor set. Backlog and Iteration Status previously hand-rolled
  `useSensors(useSensor(PointerSensor…))`, which is exactly why they diverged — there was no single
  place to add the keyboard sensor. Capacity Planning's grip already did this correctly and was the
  model.
- **`EMPTY_VALUE` (`'--'`) is the only placeholder for an absent value**, per its own docblock ("not an
  em-dash, because that is what real Rally renders"). 15 em-dash literals had drifted back in, two of
  them colliding *within one screen* — Portfolio detail rendered `'--'` in the sidebar beside `'—'` in
  both children tables. When replacing these, note that the string also appears in prose comments; a
  blind find-and-replace edits those too.
- **The frontend has ratchets too** (`apps/web/src/test/fe-consistency.ratchet.test.ts`):
  raw `<button>`, inline styles, hardcoded copy, file length, and CSRF headers on
  raw `fetch` writes. They may only decrease.
- **The SPA's API client is generated AND committed.** `apps/web/src/shared/api/generated/api.ts`
  comes from `/api/docs-json`, so any DTO change needs
  `pnpm --filter rova-web codegen` against a running local API, then a commit. The
  `OpenAPI contract` job regenerates from the spec it captured and diffs
  (`codegen:check`), so drift fails CI instead of failing at runtime.

  **`/api/docs-json` can serve a STALE document from a watch-mode restart.** Nest builds the Swagger
  document once at bootstrap, so `pnpm start:dev` recompiling is not the same thing as the served spec
  being current — it reported `Found 0 errors`, answered on the port, and still described the DTO as it
  was before the last edit. Codegen then wrote a client that was *correct for a spec nobody has*, and
  the only symptom was one absent field: `git diff` on the client was EMPTY, which reads exactly like
  "no DTO change was needed". **Grep the served spec for a marker before trusting a generated client**
  (`curl -s localhost:3000/api/docs-json | grep <newField>`), and restart the API rather than relying
  on the watcher. Worth also knowing the diff is legitimately huge when the module graph changes:
  `openapi-typescript` emits in spec order, which follows module init order, so adding one module
  import reordered ~1200 lines with no route added or removed. Compare route INVENTORIES, not the line
  count, to tell that apart from a real loss — and regenerate twice across a restart if you need to
  prove the order is deterministic, because a nondeterministic one would flake `codegen:check`.
- **`waitFor() timed out` in `notification-flow.e2e.spec.ts` is an ENVIRONMENT fault, not a flake.**
  Two independent causes, both seen in one session:
  1. **Email is unconfigured.** `.env` ships `EMAIL_PROVIDER=ses`, but `MAIL_FROM_EMAIL` is
     `.optional()` in `env.schema.ts` despite its own comment saying "Required when
     EMAIL_PROVIDER != 'dev'". Unset, `resolveFromEmail` returns `''`, every send fails with
     `Email address not verified "Mini Rally" <>`, and after three failures the email circuit
     breaker opens and stays open for the process — so the relay never delivers and the test waits
     out its 10s. Set `MAIL_FROM_EMAIL` and verify it in localstack:
     `docker exec -i rova-localstack awslocal ses verify-email-identity --email-address <addr>`.
     (The breaker is in-process, so restarting the API clears it; the failed rows are not retried
     and can be deleted.)
  2. **A live worker is a competing consumer** of `messaging.notification_outbox` and claims the
     rows the test is waiting for. Stop `pnpm start:dev:worker` before a BE e2e run.
     Neither is a product defect, and both look exactly like one. Check
     `docker ps` first: localstack dying mid-session produces the same symptom.
- **Run `pnpm lint`, not path-scoped `eslint`.** CI lints `{apps/api,apps/worker,libs,db}/**/*.ts` in one
  pass; linting only the paths you touched misses rules that fire elsewhere in that glob — and
  `no-unused-vars` exempts `^_` for ARGUMENTS only, not for destructured variables, so the
  `const { X: _unused, ...rest }` idiom is an error here. That combination put a lint failure on `main`.
- **`tsc -b` can pass on STALE build info.** Two things hid behind that in one session: an
  error code missing from the `ErrorCode` union, and a client that had never seen a new
  route (which surfaces only as `Cannot POST /v1/...` in the browser). When a change spans
  packages, verify with `tsc -b --force`.

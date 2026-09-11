# API tokens: four things correct in isolation, wrong in the graph

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

Machine credentials (`identity.api_tokens`, migration 0125). The design rationale is in the migration;
these are the integration facts that cost a debugging cycle each, all four found by
`test/e2e/api-tokens.e2e.spec.ts` and none of them visible to a unit test.

- **The resolver module must be `@Global` AND export the DI token.** `JwtAuthGuard` is constructed in
  whichever module uses `@Auth()`, so an optional dependency bound only inside `ApiTokensModule`
  resolves to `undefined` in every one of them — the guard keeps its old behaviour and every API token
  answers 401 on a route that should accept it. `IdentityModule` is `@Global` for exactly this reason
  with its BFF bridge; the pattern is not decoration.
- **A post-authentication guard cannot live on the controller.** Nest runs controller-level guards
  BEFORE route-level ones, so `@UseGuards(RejectApiTokenAuthGuard)` on the class ran before `@Auth()`
  had authenticated anything, read an unset `apiTokenId`, and allowed every token through — a token
  could mint another token, which makes a leaked one permanent. Both guards now go in ONE `UseGuards`
  array (`SessionAuthOnly`), where array order is execution order.
- **`z.date()` in a response DTO breaks Swagger metadata, not the DTO.** `nestjs-zod` throws "Date
  cannot be represented in JSON Schema" when the OpenAPI factory runs, which takes down every suite
  that boots through `bootstrapApp` — it surfaced in `csrf-protection.e2e.spec.ts`, nowhere near
  tokens. Response timestamps are `z.string().datetime()` like every other response DTO, and the
  service→wire conversion is one exported mapper.
- **`WorkspaceService` deep-imports `ApiTokensService`**, not the barrel. `@modules/api-tokens`
  re-exports the module and its controllers, which import `@modules/identity`, which imports
  `@modules/workspace` — a cycle that leaves the injected type `undefined` and fails as "argument at
  index [11]" with no name.

Two behavioural notes worth knowing before changing either:

- **`scopes` narrow; they never grant.** `PolicyGuard` asks both sides — the database-resolved
  permissions and the token's scopes — whether they grant the required code (`grantsUnderTokenScopes`).
  It is two-sided rather than an array intersection because either side can hold a wildcard, and an
  intersection gets both directions wrong: an admin whose baseline is `workspace:*` minting a
  `work_item:view` token has no literal overlap, and neither does a `work_item:*` scope over a
  `work_item:view` baseline. Permissions are still never READ from the token, so this is not the
  `claims.permissions` snapshot returning.
- **Offboarding revokes tokens, and cache invalidation is not enough.** Dropping the permission cache
  makes the principal powerless but leaves the credential AUTHENTICATING for up to a year, and a live
  401-vs-403 distinction is the difference between a credential that is dead and one that is merely
  idle. `removeMember` and a suspension both call `revokeAllForUser`, best-effort so a transient
  failure cannot roll back a removal that already committed.

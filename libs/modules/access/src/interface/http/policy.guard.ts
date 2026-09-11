import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionDeniedException } from '@platform';
import type { JwtPayload } from '@platform';
import {
  permissionGrants,
  isProjectTierPermission,
  type WorkspacePermission,
  type ProjectPermission,
  type Permission,
} from '@shared-kernel';
import { AccessService } from '../../application/access.service';
import {
  ProjectScopeResolver,
  type ScopedResource,
} from '../../application/project-scope.resolver';

export const POLICY_KEY = 'policy';
export const AUTHZ_MODE_KEY = 'authzMode';

/**
 * THE MODE DECORATORS DECLARE, THEY DO NOT MOUNT GUARDS — unlike `@RequirePermission` and
 * `@AuthPolicy`. Mounting `PolicyGuard` from them broke DI: it needs `AccessService`, and a
 * controller like `NotificationsController` lives in a module that does not import
 * `AccessModule` (`Nest can't resolve dependencies of the PolicyGuard ... in the
 * NotificationsModule`). opshub does not hit this because its PlatformModule is `@Global`.
 *
 * That is the correct shape anyway: these say HOW a route is authorized, and the enforcement is
 * `assertEveryRouteDeclaresAuthz` refusing to boot plus whatever guard the controller already
 * mounts. Every one of these routes sits under a class-level `@Auth()` or `@AuthPolicy()`, so
 * authentication is unaffected.
 */

/**
 * How a route is authorized when it carries no permission code.
 *
 * These exist so "no `@RequirePermission`" stops being indistinguishable from "nobody decided".
 * All three are real and unavoidable — see the decorators below — but each used to be expressed
 * by the ABSENCE of a decorator, which is also what a forgotten one looks like. 45 route
 * handlers were in that state, and `assertEveryRouteDeclaresAuthz` now refuses to boot until
 * every one of them says which it is.
 *
 * Ported from opshub (quynhonsemiconductor/opshub#132), where the same fail-open existed.
 */
export type AuthzMode =
  /** The subject IS the caller; there is no cross-user access to authorize. */
  | { mode: 'self-scoped'; reason: string }
  /** Non-user-specific workspace reference data any member may read. */
  | { mode: 'shared-read'; reason: string }
  /** Decided at run time inside the service, because no static descriptor can express it. */
  | { mode: 'in-service'; reason: string; pinnedBy: string }
  /** A KNOWN missing check, declared so it is visible and counted. */
  | { mode: 'gap'; reason: string };

type IdSource = 'param' | 'query' | 'body';

/** How the guard finds the project a project-tier permission is checked against. */
export type PolicyScope =
  /** The project id is directly in the request (create/list routes). */
  | { from: IdSource; field: string }
  /** Load `resource` by an id in the request → use its projectId (post-load routes). */
  | { resource: ScopedResource; from: IdSource; field: string };

interface PolicyMeta {
  permission: Permission;
  scope?: PolicyScope;
}

/**
 * The single authorization decorator. Tier-safe by overload:
 *   - a WORKSPACE-tier code takes NO scope (checked against the JWT baseline);
 *   - a PROJECT-tier code REQUIRES a scope telling the guard where the project is
 *     — either directly in the request (`{ from, field }`) or via a resource load
 *     (`{ resource, from, field }`).
 * Passing the wrong shape is a compile error.
 */
export function RequirePermission(
  permission: WorkspacePermission,
): MethodDecorator & ClassDecorator;
export function RequirePermission(
  permission: ProjectPermission,
  scope: PolicyScope,
): MethodDecorator & ClassDecorator;
export function RequirePermission(permission: Permission, scope?: PolicyScope) {
  return SetMetadata(POLICY_KEY, { permission, scope } satisfies PolicyMeta);
}

/**
 * ONE guard for every authorization decision (replaces PermissionGuard +
 * ProjectPermissionGuard + service-level assertProjectPermission):
 *   - workspace-tier ⇒ check the DB-resolved workspace baseline;
 *   - project-tier   ⇒ resolve the project (from the request or by loading the
 *     resource) and check `baseline ∪ project-scoped role`.
 * Both tiers read through one cached per-(workspace, user) assignment lookup, so
 * neither answers from a token snapshot.
 * Deny ⇒ PROJECT_PERMISSION_DENIED. Fail-closed if the user is missing.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger(PolicyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly accessService: AccessService,
    private readonly scopeResolver: ProjectScopeResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<PolicyMeta | undefined>(POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!meta) {
      // An explicitly declared mode needs no permission code: the declaration IS the decision,
      // and the narrowing that makes it true lives in the service.
      const declared = this.reflector.getAllAndOverride<AuthzMode>(AUTHZ_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (declared) return true;

      // Nothing declared. This used to `return true`, so a handler nobody decorated was allowed
      // to every authenticated caller — JwtAuthGuard proved WHO, and nothing checked WHETHER.
      this.logger.error(
        { controller: context.getClass().name, handler: context.getHandler().name },
        'Route declares no authorization (@RequirePermission / @SelfScoped / ' +
          '@AuthorizedInService / @AuthzGap / @Public) — denying',
      );
      throw this.deny();
    }

    const request = context.switchToHttp().getRequest<{
      user?: JwtPayload & { scopes?: readonly string[] };
      params: Record<string, string>;
      query: Record<string, unknown>;
      body: Record<string, unknown>;
    }>();
    const user = request.user;
    if (!user) {
      this.logger.error('PolicyGuard ran before JwtAuthGuard — check guard order');
      throw this.deny();
    }

    const { permission, scope } = meta;

    // Workspace-tier: resolved from the database (Valkey-cached), never from the
    // token. A token is a mint-time snapshot, so reading permissions off it meant a
    // revoked grant stayed effective until the token rotated.
    if (!isProjectTierPermission(permission)) {
      const baseline = await this.accessService.getWorkspacePermissions(user.sub, user.workspaceId);
      if (grantsUnderTokenScopes(baseline, user.scopes, permission)) return true;
      throw this.deny();
    }

    const projectId = await this.resolveProjectId(request, scope, user.workspaceId);
    if (!projectId) throw this.deny();

    const effective = await this.accessService.getProjectPermissions(
      user.sub,
      user.workspaceId,
      projectId,
    );
    if (grantsUnderTokenScopes(effective, user.scopes, permission)) return true;

    this.logger.warn({ userId: user.sub, projectId, permission }, 'PolicyGuard: access denied');
    throw this.deny();
  }

  private async resolveProjectId(
    request: {
      params: Record<string, string>;
      query: Record<string, unknown>;
      body: Record<string, unknown>;
    },
    scope: PolicyScope | undefined,
    workspaceId: string,
  ): Promise<string | undefined> {
    if (!scope) return undefined;
    const id = this.extract(request, scope.from, scope.field);
    if (!id) return undefined;
    // `resource` scope ⇒ the id is the resource's own id; load it → projectId.
    if ('resource' in scope) return this.scopeResolver.resolve(scope.resource, id, workspaceId);
    // Otherwise the id IS the projectId.
    return id;
  }

  private extract(
    request: {
      params: Record<string, string>;
      query: Record<string, unknown>;
      body: Record<string, unknown>;
    },
    from: IdSource,
    field: string,
  ): string | undefined {
    const bag = from === 'param' ? request.params : from === 'query' ? request.query : request.body;
    const value = bag?.[field];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private deny(): PermissionDeniedException {
    return new PermissionDeniedException(
      'PROJECT_PERMISSION_DENIED',
      'You do not have permission to perform this action',
    );
  }
}

/**
 * Class decorator for controllers using the unified `@RequirePermission`.
 * Bundles JwtAuthGuard → PolicyGuard in ONE @UseGuards (guaranteed order).
 */
export const AuthPolicy = () =>
  applyDecorators(UseGuards(JwtAuthGuard, PolicyGuard), ApiBearerAuth('access-token'));

/**
 * Authenticated, and the subject IS the caller — so there is nothing to authorize beyond
 * identity: `me/*`, the notification list, a user's own permissions.
 *
 * NOT a way to skip authorization. It is a claim that the handler cannot reach another user's
 * data, and it holds only while the service keys its reads and writes off `actor.sub`. A route
 * that gained a user id parameter would silently stop qualifying, which is why the count of
 * these is ratcheted — widening the set is a decision someone makes out loud.
 */
export const SelfScoped = (reason: string) =>
  applyDecorators(
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'self-scoped', reason } satisfies AuthzMode),
    ApiBearerAuth('access-token'),
  );

/**
 * Authorization is resolved at RUN TIME inside the service, because no static descriptor can
 * express it. The real shapes in this codebase:
 *
 *   - A cross-project LIST scoped by `AccessService.listReadableProjectIds`, whose `null`
 *     sentinel means UNRESTRICTED and `[]` means nothing — a distinction a decorator cannot
 *     carry.
 *   - `work-items/by-key` and `PATCH work-items/reorder`, where the item key is workspace-unique
 *     so the owning project is unknown until the row loads (resolve-then-check).
 *   - Author-only writes, e.g. editing your own comment.
 *
 * `pinnedBy` names the test asserting BOTH directions. Required, because this mode moves the
 * decision somewhere a reviewer cannot see from the route.
 */
export const AuthorizedInService = (reason: string, pinnedBy: string) =>
  applyDecorators(
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'in-service', reason, pinnedBy } satisfies AuthzMode),
    ApiBearerAuth('access-token'),
  );

/**
 * Workspace reference data with no owner that any member may read — the role catalogue a picker
 * renders.
 *
 * Distinct from `@SelfScoped`, which claims the row belongs to the caller. Only for data where
 * there is no owner at all; if a row belongs to someone, it needs a permission or self-scoping.
 */
export const SharedRead = (reason: string) =>
  applyDecorators(
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'shared-read', reason } satisfies AuthzMode),
    ApiBearerAuth('access-token'),
  );

/**
 * A route with a KNOWN missing authorization check, declared so it is counted rather than
 * hidden among the undecorated.
 *
 * A debt marker, not a mode. `route-policy.ratchet.spec.ts` counts these and the number may only
 * FALL; adding one is a decision to ship a known hole and must be argued in review.
 */
export const AuthzGap = (reason: string) =>
  applyDecorators(
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'gap', reason } satisfies AuthzMode),
    ApiBearerAuth('access-token'),
  );

/**
 * Whether a principal is granted `required`, accounting for an API token's scopes.
 *
 * BOTH sides must grant it: the database (what the user actually holds) and the token's scope list
 * (what this credential is allowed to use). Absent or empty scopes mean no narrowing, which is what a
 * token minted without a scope list gets and what every non-token principal gets — a cookie session and
 * a JWT carry no scopes at all.
 *
 * Two-sided, rather than intersecting the arrays, because either side can hold a wildcard and an array
 * intersection gets both cases wrong. An admin whose baseline is `workspace:*` minting a
 * `work_item:view` token has no literal overlap to intersect, and a `work_item:*` scope over a baseline
 * of `work_item:view` has none either — the first would silently grant nothing, the second the same.
 * Asking "does each side grant THIS permission" is the question the guard actually needs answered, and
 * `permissionGrants` already knows the wildcard rule, so it is reused on both sides rather than a second
 * matcher being written to eventually disagree with it.
 *
 * The direction still holds: scopes can only subtract. Nothing here consults the token for a permission
 * the database did not return, so a token is always a subset of its owner and a revoked grant takes
 * effect on the token's next request.
 */
export function grantsUnderTokenScopes(
  baseline: string[],
  scopes: readonly string[] | undefined,
  required: string,
): boolean {
  if (!permissionGrants(baseline, required)) return false;
  if (!scopes || scopes.length === 0) return true;
  return permissionGrants([...scopes], required);
}

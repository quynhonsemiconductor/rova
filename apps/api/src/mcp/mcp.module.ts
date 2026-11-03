import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { McpPrincipalGuard } from './principal.guard';
import { McpWriteGuard } from './write.guard';
import { MCP_WRITE_ROUTE_SET, MCP_WRITE_ROUTES } from './write-policy';

/**
 * The MCP module: the principal bridge and (via the bootstrap, not a controller) the raw `/mcp`
 * route. No controllers, no services, no repositories — tools compose the app's own REST routes
 * in-process, so there is nothing here to authorize with directly (that is the ratchet's point).
 *
 * Imported between `ApiTokensModule` and `AuthModule`: global guard order is module order, and
 * `McpPrincipalGuard` must run AFTER `ApiTokenGuard` (a `rly_` token owns its request) and
 * BEFORE identity's `SessionGuard` (so `markPreAuthenticated` makes it stand aside — but still
 * run its ban check — for an MCP principal). Pinned by principal.guard.spec.ts.
 *
 * `McpWriteGuard` is registered SECOND, deliberately: it keys off the bridge marker the first
 * guard sets, and it must run before any controller on an injected write.
 */
@Module({
  providers: [
    { provide: APP_GUARD, useClass: McpPrincipalGuard },
    { provide: MCP_WRITE_ROUTE_SET, useValue: MCP_WRITE_ROUTES },
    { provide: APP_GUARD, useClass: McpWriteGuard },
  ],
})
export class McpModule {}

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { McpPrincipalGuard } from './mcp-principal.guard';

/**
 * The MCP module: the principal bridge and (via the bootstrap, not a controller) the raw `/mcp`
 * route. No controllers, no services, no repositories — tools compose the app's own REST routes
 * in-process, so there is nothing here to authorize with directly (that is the ratchet's point).
 *
 * Imported between `ApiTokensModule` and `AuthModule`: global guard order is module order, and
 * `McpPrincipalGuard` must run AFTER `ApiTokenGuard` (a `rly_` token owns its request) and
 * BEFORE identity's `SessionGuard` (so `markPreAuthenticated` makes it stand aside — but still
 * run its ban check — for an MCP principal). Pinned by mcp-principal.guard.spec.ts.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: McpPrincipalGuard }],
})
export class McpModule {}

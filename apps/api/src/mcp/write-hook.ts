import type { FastifyInstance } from 'fastify';
import { MCP_CALL_TOKEN_HEADER, peekMcpCallToken } from '@platform';
import { mcpRequestAllowed } from './write-policy';

/**
 * The same route gate as `McpWriteGuard`, for the routes Nest's global guards do NOT cover:
 * the RAW Fastify routes the bootstrap registers (probes, the identity bearer endpoints,
 * `/mcp` itself). A global APP_GUARD only runs inside Nest's router; an `inject()` from a tool
 * goes through Fastify first, so a raw route would otherwise be reachable with the call token.
 *
 * `onRequest` runs after routing, so `routeOptions.url` is the matched template. A request that
 * carries no live MCP call token is ignored entirely (the web and API tokens are untouched); a
 * carried token is a fact only the MCP transport can create, so it is judged by the same
 * read/write allowlists as a guarded request and refused 403 otherwise.
 */
export function registerMcpWriteHook(
  fastify: FastifyInstance,
  options: {
    writesEnabled: boolean;
    reads: ReadonlySet<string>;
    writes: ReadonlySet<string>;
  },
): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    if (peekMcpCallToken(request.headers[MCP_CALL_TOKEN_HEADER]) === undefined) {
      done();
      return;
    }
    const route = (request as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
    if (mcpRequestAllowed(request.method, route, options)) {
      done();
      return;
    }
    void reply.code(403).send({
      code: 'MCP_WRITE_NOT_ALLOWED',
      message: 'This MCP session may not perform that request. Use the web app.',
    });
  });
}

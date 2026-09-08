import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RequestContextService } from './request-context';

/**
 * Client-supplied correlation ids are echoed into every log line and back out
 * in a response header, so they are untrusted input on both paths and must be
 * constrained before either.
 *
 * The character class — not a UUID pattern — is the deliberate part. A strict
 * UUID check would silently discard the perfectly valid non-UUID ids upstream
 * systems emit (ULIDs, hex trace ids, nanoids) and break correlation across a
 * request chain, which is the entire point of the header. What actually has to
 * be excluded is anything that can inject: CR, LF, control characters and
 * whitespace. This allows the formats real callers send and nothing that can
 * forge a log record or split a response header.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * W3C Trace Context is a fully specified wire format, so here an exact match is
 * correct rather than over-strict: `version-traceid-spanid-flags`. A malformed
 * value is not a different-looking id, it is not a traceparent at all, and
 * forwarding it would corrupt the trace it claims to join.
 */
const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Seeds AsyncLocalStorage context on every inbound request.
 * Sets correlationId from inbound header or generates a new one.
 * workspaceId/userId remain undefined until JwtAuthGuard populates them post-auth.
 */
@Injectable()
export class AsyncLocalStorageMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContextService) {}

  use(
    req: { headers: Record<string, string | string[] | undefined> },
    res: { setHeader(name: string, value: string): void },
    next: () => void,
  ): void {
    const supplied =
      firstHeader(req.headers['x-correlation-id']) ?? firstHeader(req.headers['x-request-id']);
    const correlationId =
      supplied !== undefined && SAFE_CORRELATION_ID.test(supplied) ? supplied : randomUUID();

    res.setHeader('x-correlation-id', correlationId);

    const traceparent = firstHeader(req.headers['traceparent']);

    this.ctx.run(
      {
        workspaceId: undefined,
        userId: undefined,
        sessionId: undefined,
        correlationId,
        traceparent:
          traceparent !== undefined && W3C_TRACEPARENT.test(traceparent) ? traceparent : undefined,
      },
      next,
    );
  }
}

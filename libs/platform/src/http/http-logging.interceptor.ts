import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { DomainException as SharedDomainException } from '@quynhonsemiconductor/platform-http';
import {
  HttpMetrics,
  IGNORED_REQUEST_PATHS,
  normalizeRoute,
} from '@quynhonsemiconductor/observability';
import { AppConfigService } from '../config/app-config.service';
import { albReceivedAtMs, albWaitMs, arrivalAtMs } from '@quynhonsemiconductor/platform-runtime';

/** Routes whose access logs are suppressed (probes + favicon spam). */
/**
 * Paths worth neither a log line nor a metric. Shared with the tracer via
 * `IGNORED_REQUEST_PATHS` rather than duplicated here — the two lists had already
 * diverged once, which meant a path could be traced but not logged with nothing
 * flagging it.
 */
const SKIP_LOG_PREFIXES = IGNORED_REQUEST_PATHS;

/** Body fields that must never appear in logs. */
const REDACTED_BODY_FIELDS = new Set([
  'password',
  'confirmPassword',
  'currentPassword',
  'newPassword',
  'token',
  'refreshToken',
  'secret',
  'privateKey',
  'creditCard',
]);

const MAX_COLLECTION_ITEMS = 20;
const MAX_STRING_LENGTH = 256;

function isSensitiveKey(key: string): boolean {
  return (
    REDACTED_BODY_FIELDS.has(key) || /(token|secret|password|cookie|authorization|key)$/i.test(key)
  );
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]';

  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeValue(childValue, childKey);
    }
    return sanitized;
  }

  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }

  return value;
}

/**
 * HttpLoggingInterceptor
 *
 * Emits ONE structured log per request on completion:
 *   <-- POST /v1/auth/login 200 45ms userId=xxx
 *
 * `correlationId`, `workspaceId` and trace ids are added to every line by the pino
 * mixin from AsyncLocalStorage, so this interceptor does not repeat them. It used to
 * read the `x-correlation-id` REQUEST header, which is absent whenever the client
 * did not send one — i.e. the field was usually undefined while the mixin already
 * had the generated value.
 *
 * Logs at WARN for 4xx, ERROR for 5xx, LOG for the rest.
 * Body is included for POST/PUT/PATCH with sensitive fields redacted.
 * pino-http autoLogging should be disabled when this interceptor is active.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: HttpMetrics,
  ) {}

  /**
   * Route TEMPLATE for the metric label. Nest exposes the matched path on the
   * Fastify request; when it is absent, fall back to normalising the concrete path.
   * A raw URL here would put one label value per work-item id into the metric
   * store — the classic cardinality blow-up.
   */
  /**
   * Server-sent-event responses stay open for minutes, so recording that as request
   * latency would dominate the p95 for the whole route and make the number useless.
   * Count the request, skip the duration.
   *
   * THE GUARD BELONGS ON BOTH THE SUCCESS AND THE ERROR TAP, and for a while it was
   * only on the success one. Impact was small in practice — the only streaming route,
   * `GET /notifications/stream`, calls `reply.hijack()` and its handler returns as
   * soon as setup completes, so a rejection there carries setup time rather than
   * connection lifetime — but the asymmetry is a trap rather than a decision. Any
   * future stream that keeps its handler alive for the life of the connection (an
   * `await` on a close promise is the obvious shape) would report a
   * connection-lifetime "latency" on the error path only, and the resulting p99 would
   * be minutes for reasons no dashboard could explain. Two paths, one rule.
   *
   * The header read works through a hijacked reply. `NotificationSseController` sets
   * `Content-Type` on `reply.raw`, not on the FastifyReply, and Fastify's
   * `Reply.prototype.getHeader` falls through to `this.raw.getHeader(key)` when its
   * own header store has no entry (fastify 5, `lib/reply.js`) — so the streaming
   * response is detectable from either tap. `getHeader` stays OPTIONAL in the
   * parameter type because a non-Fastify response object (an interceptor unit test's
   * stub, a future adapter) legitimately has none, and an absent header must read as
   * "not streaming" rather than throw inside a metrics guard.
   */
  private isStreaming(response: { getHeader?: (name: string) => unknown }): boolean {
    const contentType = response.getHeader?.('content-type');
    return typeof contentType === 'string' && contentType.includes('text/event-stream');
  }

  private routeLabel(req: FastifyRequest, url: string): string {
    const matched = (req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
    return matched ?? normalizeRoute(url);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    // The principal's id is `sub`, not `id` — this read was `req.user?.id`, which
    // always resolved to undefined, so the access log's userId field was dead. The
    // pino mixin also supplies userId from AsyncLocalStorage once the guard has run;
    // this covers the window before that (and requests that never authenticate).
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { sub?: string } }>();
    const method = req.method;
    const url =
      ((req as unknown as Record<string, unknown>)['originalUrl'] as string | undefined) ?? req.url;

    if (SKIP_LOG_PREFIXES.has(url)) {
      return next.handle();
    }

    const startTime = Date.now();

    // Interval attribution. `startTime` is the Nest pipeline entry, so `duration`
    // below has never included the time before it — which is why this app reported
    // `202 3ms` for the same webhook requests the ALB recorded at 2-27s. Both
    // numbers were correct and the log still read as an alibi.
    //
    // `bodyWaitMs` also covers guards, which run ahead of interceptors; that is
    // acceptable because the routes this exists to explain are @Public. `albWaitMs` is
    // omitted below its noise floor — see ALB_WAIT_REPORTING_FLOOR_MS.
    const arrival = arrivalAtMs(req);
    const traceHeader = req.headers['x-amzn-trace-id'];
    const albAt = albReceivedAtMs(Array.isArray(traceHeader) ? traceHeader[0] : traceHeader);
    const albWait = albWaitMs(arrival, albAt);
    const bodyWaitMs = arrival !== undefined ? startTime - arrival : undefined;

    const ip =
      (req.headers['x-real-ip'] as string) ||
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      'unknown';

    return next.handle().pipe(
      tap({
        next: () => {
          const response = context
            .switchToHttp()
            .getResponse<{ statusCode: number; getHeader?: (name: string) => unknown }>();
          const statusCode = response.statusCode;
          const duration = Date.now() - startTime;
          const userId = req.user?.sub;
          // Streams are excluded from HTTP RED entirely rather than recorded with a
          // connection-lifetime "latency": an SSE response is not a request/response
          // exchange, and its minutes-long duration would dominate the route's p95.
          // If connection counts become interesting they want their own instrument.
          if (!this.isStreaming(response)) {
            this.metrics.record({
              route: this.routeLabel(req, url),
              method,
              statusCode,
              durationMs: duration,
            });
          }

          this.log(statusCode, {
            msg: `<-- ${method} ${url} ${statusCode} ${duration}ms`,
            method,
            url,
            statusCode,
            duration,
            albWaitMs: albWait,
            bodyWaitMs,
            userId,
            ip,
            query: this.extractQuery(req),
          });
        },
        error: (err: unknown) => {
          const duration = Date.now() - startTime;
          // Reflect the ACTUAL response status in the access log. The global
          // exception filter maps DomainException (rally's own or a shared
          // @quynhonsemiconductor/* package's — both extend the shared base) to its
          // `httpStatus`; without this branch such errors would be mislogged as
          // 500/INTERNAL and pollute 5xx error-rate alerts. Fall back to Nest's
          // HttpException accessors, then to 500.
          let statusCode: number;
          let errorCode: string;
          if (err instanceof SharedDomainException) {
            statusCode = err.httpStatus;
            errorCode = err.code;
          } else {
            statusCode = (err as { getStatus?: () => number }).getStatus?.() ?? 500;
            errorCode =
              (err as { getResponse?: () => { code?: string } }).getResponse?.()?.code ??
              'INTERNAL';
          }
          const userId = req.user?.sub;
          // Same streaming exclusion as the success tap above — see isStreaming for
          // why it has to be on both. The response is fetched here only for that
          // check: `statusCode` comes from the EXCEPTION, not from the reply, because
          // the global filter has not written the status yet at this point.
          const response = context
            .switchToHttp()
            .getResponse<{ getHeader?: (name: string) => unknown }>();
          if (!this.isStreaming(response)) {
            this.metrics.record({
              route: this.routeLabel(req, url),
              method,
              statusCode,
              durationMs: duration,
              errorCode,
            });
          }

          this.log(statusCode, {
            msg: `<-- ${method} ${url} ${statusCode} ${duration}ms [${errorCode}]`,
            method,
            url,
            statusCode,
            duration,
            albWaitMs: albWait,
            bodyWaitMs,
            errorCode,
            userId,
            ip,
            query: this.extractQuery(req),
            body: this.extractBody(req),
          });
        },
      }),
    );
  }

  private log(statusCode: number, fields: Record<string, unknown>): void {
    if (statusCode >= 500) {
      this.logger.error(fields);
    } else if (statusCode >= 400) {
      this.logger.warn(fields);
    } else {
      this.logger.log(fields);
    }
  }

  private extractQuery(req: FastifyRequest): Record<string, unknown> | undefined {
    const q = req.query as Record<string, unknown> | undefined;
    if (!q || Object.keys(q).length === 0) return undefined;
    return sanitizeValue(q) as Record<string, unknown>;
  }

  private extractBody(req: FastifyRequest): Record<string, unknown> | undefined {
    if (!this.config.get('LOG_HTTP_BODIES')) return undefined;
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return undefined;
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return undefined;
    return sanitizeValue(body) as Record<string, unknown>;
  }
}

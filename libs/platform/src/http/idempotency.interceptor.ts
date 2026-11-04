import { Reflector } from '@nestjs/core';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, finalize, switchMap, tap } from 'rxjs/operators';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { clientIp, currentUserId } from '@quynhonsemiconductor/platform-http';
import { ConflictException, DomainException } from '../errors/exceptions';
import { IS_PUBLIC_KEY } from '../auth/public-key';

/** TTL for cached idempotent responses (24 hours). */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Only mutating methods carry idempotency semantics. */
const IDEMPOTENCY_METHODS = new Set(['POST', 'PUT']);

/**
 * IdempotencyInterceptor
 *
 * Reads the `Idempotency-Key` header on POST/PUT requests.
 * On the first call the response is stored in Valkey; subsequent calls
 * with the same key return the cached response immediately, making the
 * operation safe to retry.
 *
 * Cache key: `idem:{userId}:{method}:{url}:{idempotency-key}`
 *
 * Usage (opt-in per route): `@UseIdempotency()`
 * Usage (global):           register as APP_INTERCEPTOR in app.module.ts
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { sub?: string } }>();

    if (!IDEMPOTENCY_METHODS.has(req.method)) return next.handle();

    const headerVal = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!idempotencyKey) return next.handle();

    // WHO is calling: the request context first (platform-http >= 5; the guard writes it), then the guard's own
    // `req.user`. The second matters when no context was seeded (CORRELATION_ID_MODE=disabled makes
    // `setRequestPrincipal` a no-op): without it an AUTHENTICATED caller would be scoped by address + User-Agent, and
    // two users behind one NAT with the same Idempotency-Key and URL could be handed each other's cached response.
    const known = currentUserId() ?? req.user?.sub;
    let userId: string;
    if (known) {
      userId = known;
    } else {
      // No user id. On a route that needs authentication that means the caller was authenticated by something that
      // recorded no principal: scoping by address would let two people behind one NAT share an entry, so NOTHING is
      // cached (the request still runs). Only an `@Public()` route has no user by design, and is told apart by address.
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!isPublic) {
        this.logger.warn(
          'idempotency: an authenticated route has no user id on the request; not caching',
        );
        return next.handle();
      }
      userId = createHash('sha256')
        .update(`${clientIp(req)}:${req.headers['user-agent'] ?? ''}`)
        .digest('hex')
        .slice(0, 16);
    }
    const redisKey = `idem:${userId}:${req.method}:${req.url}:${idempotencyKey}`;
    const inFlightKey = `${redisKey}:inflight`;
    const requestHash = hashBody((req as FastifyRequest & { body?: unknown }).body);

    return from(this.cache.instance.get(redisKey)).pipe(
      // A cache READ failure is not the caller's problem: run the request, cache nothing. (The
      // write-side promise, below, is the same rule for the same reason.)
      catchError(() => {
        this.logger.warn({ msg: 'idempotency: cache read failed; passing through', redisKey });
        return of(undefined as string | null | undefined);
      }),
      switchMap((cached: string | null | undefined) => {
        if (cached === undefined) return next.handle();

        if (cached !== null) {
          this.logger.debug({ msg: 'idempotency: cache hit', redisKey });
          let parsed: unknown;
          try {
            parsed = JSON.parse(cached);
          } catch {
            return next.handle();
          }
          const entry = parsed as { v?: unknown; hash?: unknown; response?: unknown };
          if (entry.v === 1) {
            // IETF idempotency-key draft: a key replayed with a DIFFERENT request body is a
            // client error, not a replay. Without this, a model retry that edited its arguments
            // would silently receive the first request's response.
            if (entry.hash !== requestHash) {
              return throwError(
                () =>
                  new DomainException(
                    'IDEMPOTENCY_KEY_REUSED',
                    'This Idempotency-Key was already used with a different request body.',
                    'VALIDATION_FAILED',
                  ),
              );
            }
            return of(entry.response);
          }
          // An entry written before the hash was stored: replay it (its response is the shape
          // clients expect) rather than fail a call the key legitimately owns.
          return of(parsed);
        }

        // First call: take a short in-flight lock so two concurrent duplicates do not both run.
        return from(
          this.cache.instance.set(inFlightKey, requestHash, 'EX', IN_FLIGHT_TTL_SECONDS, 'NX'),
        ).pipe(
          catchError(() => of('OK')), // cache unavailable: let the request run
          switchMap((acquired: unknown) => {
            if (acquired === null) {
              return throwError(
                () =>
                  new ConflictException(
                    'IDEMPOTENCY_IN_FLIGHT',
                    'A request with this Idempotency-Key is already in progress. Retry shortly.',
                  ),
              );
            }
            return next.handle().pipe(
              tap(async (response: unknown) => {
                try {
                  await this.cache.instance.set(
                    redisKey,
                    JSON.stringify({ v: 1, hash: requestHash, response }),
                    'EX',
                    IDEMPOTENCY_TTL_SECONDS,
                  );
                } catch (err) {
                  // Cache failure must NOT fail the request
                  this.logger.warn({ msg: 'idempotency: failed to cache response', err });
                }
              }),
              finalize(() => {
                void Promise.resolve(this.cache.instance.del(inFlightKey)).catch(() => undefined);
              }),
            );
          }),
        );
      }),
    );
  }
}

/** How long a first call holds its "in progress" marker; the TTL also frees a crashed run. */
const IN_FLIGHT_TTL_SECONDS = 30;

/** sha256 over a key-sorted JSON form of the body: the body is what the key must not be reused for. */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`)
    .join(',')}}`;
}

/** Convenience decorator — apply IdempotencyInterceptor to a single route. */
export const UseIdempotency = () => UseInterceptors(IdempotencyInterceptor);

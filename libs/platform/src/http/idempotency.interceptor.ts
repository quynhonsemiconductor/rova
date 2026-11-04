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
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
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
    const reply = context.switchToHttp().getResponse<{
      statusCode: number;
      status(code: number): unknown;
      header(name: string, value: string): unknown;
      getHeader(name: string): unknown;
    }>();
    /** What the route answers when nothing overrides it — captured so a replay carries the FIRST
     * call's status, not whatever the route happens to default to when the retry arrives. */
    const defaultStatus =
      (Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined) ??
      (req.method === 'POST' ? 201 : 200);

    const release = async () => {
      try {
        await this.cache.instance.del(inFlightKey);
      } catch {
        // Releasing is best-effort; the TTL frees a marker whose release failed.
      }
    };

    const parseEntry = (cached: string | null | undefined): Record<string, unknown> | undefined => {
      if (cached === undefined) return undefined; // a read failure (already logged)
      if (cached === null) return null as unknown as undefined; // no entry: caller distinguishes
      try {
        return JSON.parse(cached) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    const cachedValue = (cached: string | null | undefined) =>
      cached === undefined ? undefined : parseEntry(cached);
    const replay = (entry: Record<string, unknown>) => {
      if (entry['v'] === 1) {
        // IETF idempotency-key draft: the same key with a DIFFERENT body is a client error, not
        // a replay. Without this, a model retry that edited its arguments would silently receive
        // the first request's response.
        if (entry['hash'] !== requestHash) {
          return throwError(
            () =>
              new DomainException(
                'IDEMPOTENCY_KEY_REUSED',
                'This Idempotency-Key was already used with a different request body.',
                'VALIDATION_FAILED',
              ),
          );
        }
        if (typeof entry['status'] === 'number') reply.status(entry['status']);
        // The concurrency token must replay with the answer: a client that retries a create
        // needs the ETag of the row that was actually created, not a fresh read.
        if (typeof entry['etag'] === 'string') reply.header('ETag', entry['etag']);
        return of(entry['response']);
      }
      // An entry written before {hash,status} existed: replay its body, route status.
      return of(entry);
    };
    const readCache = () =>
      from(this.cache.instance.get(redisKey)).pipe(
        catchError(() => {
          this.logger.warn({ msg: 'idempotency: cache read failed; passing through', redisKey });
          return of(undefined as string | null | undefined);
        }),
      );

    return readCache().pipe(
      switchMap((first: string | null | undefined) => {
        const entry = cachedValue(first);
        if (entry === undefined) return next.handle(); // read/parse failure: pass through
        if (entry !== null) return replay(entry);

        // First call: take a short in-flight lock so two concurrent duplicates do not both run.
        return from(
          this.cache.instance.set(inFlightKey, requestHash, 'EX', IN_FLIGHT_TTL_SECONDS, 'NX'),
        ).pipe(
          catchError(() => of('OK')), // cache unavailable: let the request run
          switchMap((acquired: unknown) => {
            if (acquired === null) {
              // The lock is held. The holder may have FINISHED between our first read and the
              // NX: re-read before deciding it is still in flight.
              return readCache().pipe(
                switchMap((again) => {
                  const raced = cachedValue(again);
                  if (raced) return replay(raced);
                  return throwError(
                    () =>
                      new ConflictException(
                        'IDEMPOTENCY_IN_FLIGHT',
                        'A request with this Idempotency-Key is already in progress. Retry shortly.',
                      ),
                  );
                }),
              );
            }

            // Lock taken; re-read once more: another holder may have written between our read
            // and the NX (the GET-miss / SET-NX race), in which case replay instead of running.
            return readCache().pipe(
              switchMap((again) => {
                const raced = cachedValue(again);
                if (raced) {
                  void release();
                  return replay(raced);
                }
                // Capture the response on the way out and persist in FINALIZE: finalize runs on
                // complete, error AND unsubscribe (a client tearing down mid-request), so the
                // cache write and the lock release are not skipped by a torn-down subscriber.
                // The persistence itself AWAITS the cache SET before releasing the lock, so a
                // duplicate arriving right after a release finds the cached answer.
                let captured: { response?: unknown } = {};
                return next.handle().pipe(
                  tap({
                    next: (response: unknown) => {
                      captured = { response };
                    },
                  }),
                  finalize(() => {
                    const response = captured.response;
                    const etag = reply.getHeader('etag');
                    const status = reply.statusCode !== 200 ? reply.statusCode : defaultStatus;
                    void (async () => {
                      if (response !== undefined) {
                        try {
                          await this.cache.instance.set(
                            redisKey,
                            JSON.stringify({
                              v: 1,
                              hash: requestHash,
                              status,
                              ...(typeof etag === 'string' ? { etag } : {}),
                              response,
                            }),
                            'EX',
                            IDEMPOTENCY_TTL_SECONDS,
                          );
                        } catch (err) {
                          // Cache failure must NOT fail the request
                          this.logger.warn({ msg: 'idempotency: failed to cache response', err });
                        }
                      }
                      await release();
                    })();
                  }),
                );
              }),
            );
          }),
        );
      }),
    );
  }
}

/**
 * How long a first call holds its "in progress" marker: 60 s, comfortably above any single
 * create handler (one DB transaction; the slowest observed create is well under 5 s) and above a
 * gzip/network stall of the injected call. The TTL also frees a marker whose process crashed.
 */
const IN_FLIGHT_TTL_SECONDS = 60;

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

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
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { clientIp, currentUserId } from '@quynhonsemiconductor/platform-http';
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

    return from(this.cache.instance.get(redisKey)).pipe(
      switchMap((cached: string | null) => {
        if (cached !== null) {
          this.logger.debug({ msg: 'idempotency: cache hit', redisKey });
          return of(JSON.parse(cached) as unknown);
        }

        return next.handle().pipe(
          tap(async (response: unknown) => {
            try {
              await this.cache.instance.set(
                redisKey,
                JSON.stringify(response),
                'EX',
                IDEMPOTENCY_TTL_SECONDS,
              );
            } catch (err) {
              // Cache failure must NOT fail the request
              this.logger.warn({ msg: 'idempotency: failed to cache response', err });
            }
          }),
        );
      }),
    );
  }
}

/** Convenience decorator — apply IdempotencyInterceptor to a single route. */
export const UseIdempotency = () => UseInterceptors(IdempotencyInterceptor);

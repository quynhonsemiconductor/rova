/**
 * An Idempotency-Key is scoped to the CALLER. Two users who send the same key, to the same URL, with the same
 * User-Agent, from the same address (one NAT), each get their OWN response, and neither is ever handed the other's.
 *
 * Why this is its own spec. `IdempotencyInterceptor` keys its cache entry by the user, and learns who that is from the request
 * context (platform-http >= 5) or, failing that, from `req.user`. This module is built WITHOUT `enableCorrelationId`, so there is
 * NO request context: `setRequestPrincipal` is a no-op, `currentUserId()` is undefined, and the only thing separating the two
 * users is the `req.user` fallback. Take that fallback away and both callers fall into one address+User-Agent bucket, and the
 * second one receives the first one's cached answer. (`UseIdempotency` is not applied to any production route yet; this proves the
 * interceptor is safe before one is.)
 */
import 'reflect-metadata';
import { Controller, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module';
import { SelfScoped } from '../../libs/modules/access/src';
import { Auth, CurrentUser } from '../../libs/platform/src/auth/decorators';
import type { JwtPayload } from '../../libs/platform/src/auth/jwt.strategy';
import { UseIdempotency } from '../../libs/platform/src/http/idempotency.interceptor';

let handled = 0;

/** A probe route that answers with WHO it ran for and how many times the handler has run. */
@Controller('idempotency-probe')
class IdempotencyProbeController {
  @Post()
  @SelfScoped('test probe: answers with the caller’s own id')
  @Auth()
  @UseIdempotency()
  run(@CurrentUser() user: JwtPayload): { caller: string; handled: number } {
    handled += 1;
    return { caller: user.sub, handled };
  }
}

describe('Idempotency-Key is scoped to the caller (e2e)', () => {
  let app: NestFastifyApplication;
  let auth: AuthService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [IdempotencyProbeController],
    })
      .overrideProvider(EntraTokenVerifier)
      .useValue({
        verify: async (idToken: string): Promise<EntraClaims> => JSON.parse(idToken) as EntraClaims,
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    auth = app.get(AuthService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = async (email: string, key: string) => {
    const { accessToken } = await auth.devLogin(email, '127.0.0.1');
    const res = await app.inject({
      method: 'POST',
      url: '/idempotency-probe',
      remoteAddress: '203.0.113.7', // the same address for everyone: one NAT
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'curl/8',
        'idempotency-key': key,
      },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body) as { caller: string; handled: number };
  };

  it('two users, same key + URL + User-Agent + address: each gets their own response', async () => {
    const key = randomUUID();
    const admin = await post('admin@qnsc.dev', key);
    const viewer = await post('viewer@qnsc.dev', key);

    expect(admin.caller).not.toBe(viewer.caller);
    expect(viewer.handled).toBe(admin.handled + 1); // the second user's request RAN; it was not answered from the first's entry
  });

  it('the same user retrying the same key gets the first answer back, without the handler running again', async () => {
    const key = randomUUID();
    const first = await post('admin@qnsc.dev', key);
    const retry = await post('admin@qnsc.dev', key);

    expect(retry).toEqual(first);
    // and the other user's entry for the same key is still their own
    const other = await post('viewer@qnsc.dev', key);
    expect(other.caller).not.toBe(first.caller);
  });
});

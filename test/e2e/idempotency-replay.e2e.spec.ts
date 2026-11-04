/**
 * Idempotency-Key semantics at the HTTP envelope (PR0b review): a replay with the SAME body
 * returns the first response; the same key with a DIFFERENT body is refused 422
 * `IDEMPOTENCY_KEY_REUSED` (IETF idempotency-key draft) instead of being handed the first body's
 * answer. The in-flight 409 is unit-tested in `test/idempotency-interceptor.unit.spec.ts`.
 */
import 'reflect-metadata';
import { Body, Controller, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module';
import { SelfScoped } from '../../libs/modules/access/src';
import { Auth, CurrentUser } from '../../libs/platform/src/auth/decorators';
import type { JwtPayload } from '../../libs/platform/src/auth/principal';
import { UseIdempotency } from '../../libs/platform/src/http/idempotency.interceptor';
import { signIn } from './support/session';

let handled = 0;

@Controller('idempotency-replay-probe')
class IdempotencyReplayProbeController {
  @Post()
  @SelfScoped('test probe: echoes the body it handled')
  @Auth()
  @UseIdempotency()
  run(
    @CurrentUser() user: JwtPayload,
    @Body() body: { note?: string },
  ): { note: string; handled: number; caller: string } {
    handled += 1;
    return { note: body.note ?? '', handled, caller: user.sub };
  }
}

describe('Idempotency-Key replay vs reuse (e2e)', () => {
  let app: NestFastifyApplication;
  let cookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [IdempotencyReplayProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    cookie = await signIn(app, 'admin@qnsc.dev');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const post = (key: string, note: string) =>
    app.inject({
      method: 'POST',
      url: '/idempotency-replay-probe',
      headers: { cookie, 'idempotency-key': key },
      payload: { note },
    });

  it('replays the first response for the same key and body', async () => {
    const key = randomUUID();
    const first = await post(key, 'same');
    const second = await post(key, 'same');

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toEqual(first.json());
  });

  it('refuses the same key with a different body: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = randomUUID();
    expect((await post(key, 'first body')).statusCode).toBe(201);

    const reused = await post(key, 'a different body');
    expect(reused.statusCode, reused.body).toBe(422);
    expect(reused.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
});

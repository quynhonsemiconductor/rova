/**
 * Optimistic concurrency over HTTP (MCP v2 G1): a work-item GET emits `ETag`, PATCH honours
 * `If-Match`, and the comparison happens IN the UPDATE — so a write that landed inside the same
 * SECOND but after the caller's read is still detected (the old second-precision header idea was
 * the defect this replaces).
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { SEED_PROJECTS } from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PATCH /work-items/:id with If-Match (ETag concurrency)', () => {
  let app: NestFastifyApplication;
  let token: string;

  const send = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => app.inject({ method, url, headers: { cookie: token, ...headers }, payload });

  const createStory = async (title: string): Promise<string> => {
    const res = await send('POST', '/work-items', { projectId: NXP, type: 'story', title });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  const etagOf = async (id: string): Promise<string> => {
    const res = await send('GET', `/work-items/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const etag = res.headers.etag;
    expect(typeof etag).toBe('string');
    return String(etag);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = await signIn(app, 'admin@qnsc.dev');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('an unchanged row passes, and the PATCH answers with the NEW ETag', async () => {
    const id = await createStory('If-Match ok');
    const etag = await etagOf(id);

    const res = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'If-Match ok v2' },
      { 'if-match': etag },
    );

    expect(res.statusCode, res.body).toBe(200);
    expect(typeof res.headers.etag).toBe('string');
    expect(res.headers.etag).not.toBe(etag);
  });

  it('a write in the SAME SECOND is detected: the stale ETag is 412', async () => {
    const id = await createStory('If-Match same second');
    const first = await etagOf(id);

    await sleep(5); // a real write, still inside the same wall-clock second
    const updated = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'moved' },
      { 'if-match': first },
    );
    expect(updated.statusCode, updated.body).toBe(200);

    const stale = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'lost update' },
      { 'if-match': first },
    );
    expect(stale.statusCode, stale.body).toBe(412);
    expect(stale.json()).toMatchObject({ error: { code: 'WORK_ITEM_STALE' } });

    // And the losing write did not land.
    const read = await send('GET', `/work-items/${id}`);
    expect(read.json().title).toBe('moved');
  });

  it('no If-Match keeps the web behaviour: the update succeeds', async () => {
    const id = await createStory('If-Match absent');
    const res = await send('PATCH', `/work-items/${id}`, { title: 'web edit' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a malformed If-Match is 400, not 412', async () => {
    const id = await createStory('If-Match malformed');
    const res = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'x' },
      { 'if-match': 'not-a-tag' },
    );
    expect(res.statusCode, res.body).toBe(400);
  });
});

/**
 * Optimistic concurrency over HTTP (MCP v2 G1): every work-item response carries a strong
 * `ETag: "<version>"`, PATCH honours `If-Match`, and the UPDATE increments the version in the
 * same statement — so ANY concurrent write, even inside the same millisecond, invalidates the
 * token (a timestamp could not make that promise).
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '@platform';
import { SEED_PROJECTS } from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

describe('PATCH /work-items/:id with If-Match (ETag concurrency)', () => {
  let app: NestFastifyApplication;
  let token: string;

  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

  it('a stale version is detected even when the writes are milliseconds apart', async () => {
    const id = await createStory('If-Match rapid');
    const first = await etagOf(id);

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

  it('a WEAK validator never matches (412), and "*" matches any existing item (proceeds)', async () => {
    const id = await createStory('If-Match weak/star');
    const strong = await etagOf(id);

    const weak = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'weak attempt' },
      { 'if-match': `W/${strong}` },
    );
    expect(weak.statusCode, weak.body).toBe(412);
    expect(weak.json()).toMatchObject({ error: { code: 'WORK_ITEM_STALE' } });

    const star = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'any existing' },
      { 'if-match': '*' },
    );
    expect(star.statusCode, star.body).toBe(200);
  });

  it('every work-item response carries an ETag: create, task create, get by key, patch', async () => {
    const created = await send('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'ETag everywhere',
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers.etag).toMatch(/^"\d+"$/);
    const id = created.json().id as string;
    const key = created.json().itemKey as string;

    const task = await send('POST', `/work-items/${id}/tasks`, { title: 'child task' });
    expect(task.statusCode, task.body).toBe(201);
    expect(task.headers.etag).toMatch(/^"\d+"$/);
    // The task's ETag is the task's OWN token: it authorises a PATCH of the task...
    const patchedTask = await send(
      'PATCH',
      `/work-items/${task.json().id}`,
      { title: 'child task v2' },
      { 'if-match': String(task.headers.etag) },
    );
    expect(patchedTask.statusCode, patchedTask.body).toBe(200);
    expect(patchedTask.headers.etag).not.toBe(task.headers.etag);

    const byKey = await send('GET', `/work-items/by-key?itemKey=${encodeURIComponent(key)}`);
    expect(byKey.headers.etag).toMatch(/^"\d+"$/);

    // Creating the task reconciles the parent's derived Schedule State, which is itself a parent
    // write — so re-read the parent's token before patching it.
    const parentNow = await etagOf(id);
    const patched = await send(
      'PATCH',
      `/work-items/${id}`,
      { title: 'patched' },
      { 'if-match': parentNow },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.headers.etag).not.toBe(parentNow);
  });

  it('no If-Match keeps the web behaviour: the update succeeds', async () => {
    const id = await createStory('If-Match absent');
    const res = await send('PATCH', `/work-items/${id}`, { title: 'web edit' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a writer the APP does not run (FK ON DELETE SET NULL) still bumps the version', async () => {
    const iteration = await send('POST', '/iterations', {
      projectId: NXP,
      name: `trigger-iter-${Date.now()}`,
    });
    expect(iteration.statusCode, iteration.body).toBe(201);
    const iterationId = iteration.json().id as string;

    const created = await send('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'FK rewrite target',
      iterationId,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const before = await etagOf(id);

    // Deleting the iteration rewrites work_items.iteration_id to NULL through the FK. The
    // BEFORE UPDATE trigger bumps the version; no application code participates.
    const deleted = await send('DELETE', `/iterations/${iterationId}`);
    expect([200, 204], deleted.body).toContain(deleted.statusCode);

    const after = await etagOf(id);
    expect(after).not.toBe(before);
    const stale = await send('PATCH', `/work-items/${id}`, { title: 'x' }, { 'if-match': before });
    expect(stale.statusCode, stale.body).toBe(412);
  });

  it('a RAW SQL update bumps the version (the trigger is the single source of truth)', async () => {
    const id = await createStory('raw sql writer');
    const before = await etagOf(id);

    await app
      .get<{ execute: (query: unknown) => Promise<unknown> }>(DRIZZLE)
      .execute(sql`UPDATE work.work_items SET blocked_reason = blocked_reason WHERE id = ${id}`);

    expect(await etagOf(id)).not.toBe(before);
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

/**
 * Deleting a work item OVER HTTP — the Backlog's Delete, as the browser performs it.
 *
 * Every existing delete assertion calls `WorkItemsService.deleteWorkItem` directly, and CLAUDE.md
 * records twice why that is not enough: a spec that calls a service cannot see a guard defect. The BA
 * reports "cannot delete work item in Backlog", so the question is precisely whether the ROUTE works —
 * its permission code, its `resource: 'work_item'` scope resolution, and the two refusals that are
 * deliberate (a defect, and an Editor reaching outside their Teams) rather than faults.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import { SEED_PROJECTS, TEAM_ALPHA_ID } from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

describe('DELETE /work-items/:id (the Backlog Delete)', () => {
  let app: NestFastifyApplication;
  let adminToken: string;
  let editorToken: string;

  const as = (
    token: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { cookie: token }, payload });

  const create = async (token: string, body: Record<string, unknown>): Promise<string> => {
    const res = await as(token, 'POST', '/work-items', { projectId: NXP, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    adminToken = await signIn(app, 'admin@qnsc.dev');
    editorToken = await signIn(app, 'dev@qnsc.dev');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('deletes a STORY, and the row stops being readable', async () => {
    const id = await create(adminToken, { type: 'story', title: 'Delete me' });

    const res = await as(adminToken, 'DELETE', `/work-items/${id}`);

    expect(res.statusCode, res.body).toBe(204);
    expect((await as(adminToken, 'GET', `/work-items/${id}`)).statusCode).toBe(404);
  });

  it('deletes a TASK through the same route — its row lives in work.tasks', async () => {
    // The Phase 3 split moved tasks to their own table while the routes stayed shared, which is the
    // shape CLAUDE.md records as having broken every task surface once already.
    const parent = await create(adminToken, { type: 'story', title: 'Parent' });
    const task = await as(adminToken, 'POST', `/work-items/${parent}/tasks`, { title: 'Subtask' });
    expect(task.statusCode, task.body).toBe(201);

    const res = await as(adminToken, 'DELETE', `/work-items/${task.json().id}`);

    expect(res.statusCode, res.body).toBe(204);
  });

  it('deletes a story that HAS tasks', async () => {
    const parent = await create(adminToken, { type: 'story', title: 'Parent with children' });
    expect(
      (await as(adminToken, 'POST', `/work-items/${parent}/tasks`, { title: 'Child' })).statusCode,
    ).toBe(201);

    const res = await as(adminToken, 'DELETE', `/work-items/${parent}`);

    expect(res.statusCode, res.body).toBe(204);
  });

  /**
   * INVERTED by the BA's ruling of 2026-08-20 ("cannot delete defect in Backlog and Iteration
   * Status"). Phase 3.4 refused this for every principal; §3.2:81 grants `Delete` on Quality/Defects
   * in all three columns, and `server-role-matrix.e2e.spec.ts` had been recording the two as an
   * unresolved mismatch inside the BA's own documents.
   */
  it('deletes a DEFECT — §3.2:81, reversing Phase 3.4', async () => {
    const id = await create(adminToken, { type: 'defect', title: 'Deletable now' });

    const res = await as(adminToken, 'DELETE', `/work-items/${id}`);

    expect(res.statusCode, res.body).toBe(204);
    expect((await as(adminToken, 'GET', `/work-items/${id}`)).statusCode).toBe(404);
  });

  it('lets an Editor delete inside their own Team', async () => {
    const id = await create(adminToken, {
      type: 'story',
      title: 'Editor may delete this',
      teamId: TEAM_ALPHA_ID,
    });

    const res = await as(editorToken, 'DELETE', `/work-items/${id}`);

    expect(res.statusCode, res.body).toBe(204);
  });

  it('REFUSES an Editor a team-less item — the Project Backlog is admin-only', async () => {
    const id = await create(adminToken, { type: 'story', title: 'Project Backlog row' });

    const res = await as(editorToken, 'DELETE', `/work-items/${id}`);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PROJECT_BACKLOG_ADMIN_ONLY');
  });
});

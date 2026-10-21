/**
 * Deleting an archived Team — the destructive half of the workspace Archive surface.
 *
 * The product owner asked for archived Projects and Teams to have a visible home where they can be
 * DELETED. For a team that is not a free action: DB design §488 is "Archive Team does not delete the
 * linked Work Item/Sprint history", and the schema cannot enforce it either way. `work_items.team_id`,
 * `tasks.team_id`, `iterations.team_id` and `portfolio_items.team_id` carry NO foreign key, so a delete
 * dangles them silently; `member_capacity`, `iteration_daily_snapshots` and the two baseline tables are
 * `ON DELETE CASCADE`, so Postgres would happily destroy frozen report history. So the rule is delete
 * ONLY when there is nothing to destroy, and this file is where that is proven against a real database
 * — a mocked repository cannot show that the row and its roster are actually gone, or that a team
 * holding real seeded work is actually refused.
 *
 * The session cookie from identity's test-login (`support/session.ts`). The test app is built without `bootstrapApp`, so it has
 * no `/v1` prefix, no cookie plugin and no CSRF hook; a spec that needs those boots `createBootstrappedApp()`.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

import { AppModule } from '../../apps/api/src/app.module';
import { DEVELOPER_ID, SEED_PROJECTS, TEAM_ALPHA_ID, WORKSPACE_ID } from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

describe('deleting an archived team', () => {
  let app: NestFastifyApplication;
  let token: string;

  const as = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { cookie: token }, payload });

  /** A throwaway team of this file's own, so no seeded fixture is ever mutated. */
  const makeTeam = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const key = `A${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;
    const res = await as('POST', `/workspaces/${WORKSPACE_ID}/teams`, {
      name: `Archive delete ${key}`,
      key,
      projectIds: [NXP],
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  const archive = (teamId: string) => as('PATCH', `/teams/${teamId}`, { status: 'archived' });

  const archivedTeamIds = async (): Promise<string[]> => {
    const res = await as('GET', `/workspaces/${WORKSPACE_ID}/teams?includeInactive=true`);
    expect(res.statusCode).toBe(200);
    // Annotated rather than asserted: `eslint --fix` strips a redundant-looking assertion here (the
    // pre-commit hook runs it and re-stages), which then leaves `.filter` walking an `any`.
    const teams: Array<{ id: string; status: string }> = res.json();
    return teams.filter((t) => t.status === 'archived').map((t) => t.id);
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

  it('is REFUSED while the team is still active — delete is an archive action', async () => {
    const teamId = await makeTeam();

    const res = await as('DELETE', `/teams/${teamId}`);

    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe('TEAM_NOT_ARCHIVED');
    // Still there, and still active: a refused delete changes nothing.
    expect((await as('GET', `/teams/${teamId}`)).statusCode).toBe(200);
  });

  it('deletes an archived team that holds nothing, roster and all', async () => {
    const teamId = await makeTeam({ memberUserIds: [DEVELOPER_ID] });
    expect((await archive(teamId)).statusCode).toBe(200);
    expect(await archivedTeamIds()).toContain(teamId);

    const res = await as('DELETE', `/teams/${teamId}`);

    expect(res.statusCode).toBe(204);
    expect((await as('GET', `/teams/${teamId}`)).statusCode).toBe(404);
    expect(await archivedTeamIds()).not.toContain(teamId);
    // The roster went with it. Neither `team_members` nor `project_teams` has a foreign key to
    // `teams`, so nothing but the service would have removed them.
    expect((await as('GET', `/teams/${teamId}/members`)).statusCode).toBe(404);
  });

  it('is REFUSED for an archived team that still holds delivery history, and says what holds it', async () => {
    const teamId = await makeTeam();
    const story = await as('POST', '/work-items', {
      projectId: NXP,
      type: 'story',
      title: 'Archive delete guard',
      teamId,
    });
    expect(story.statusCode).toBe(201);
    expect((await archive(teamId)).statusCode).toBe(200);

    const res = await as('DELETE', `/teams/${teamId}`);

    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe('TEAM_HAS_HISTORY');
    // The count is the actionable part: the admin has to know what to move.
    expect(res.json().error.message).toContain('1 work items');
    expect((await as('GET', `/teams/${teamId}`)).statusCode).toBe(200);
  });

  it('leaves a SEEDED team alone — the guard is what protects recorded history', async () => {
    // Team Alpha carries seeded work items, iterations and capacity rows. Archiving it is legal;
    // deleting it must not be, or a click would take frozen Burndown history with it.
    expect((await archive(TEAM_ALPHA_ID)).statusCode).toBe(200);
    try {
      const res = await as('DELETE', `/teams/${TEAM_ALPHA_ID}`);

      expect(res.statusCode).toBe(412);
      expect(res.json().error.code).toBe('TEAM_HAS_HISTORY');
    } finally {
      // Restored whatever the assertions did: every other spec reads this fixture as active.
      expect((await as('PATCH', `/teams/${TEAM_ALPHA_ID}`, { status: 'active' })).statusCode).toBe(
        200,
      );
    }
  });
});

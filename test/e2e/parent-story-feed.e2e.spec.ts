/**
 * The Parent Story picker offers exactly the Stories the write path accepts. Over real HTTP.
 *
 * THE DEFECT (BA repro, Production, verified 2026-08-21)
 * Opening a Defect's `Parent Story` field offered nothing but `No parent story`, and searching a
 * Story's key answered `No matches`, so a Defect could not be traced to the User Story it was found
 * against. All three Parent Story surfaces — the detail sidebar, Create Work Item, and Log Defect —
 * fed the picker from `GET /work-items/backlog?type=story`. That endpoint is the Backlog SCREEN's
 * feed and carries that screen's DEFINING rule, `iteration_id IS NULL`, plus a 50-row first page.
 * `updateWorkItem` has no such rule: it accepts any non-deleted Story in the same project. So every
 * Story that had been pulled into a sprint — which is most of them, and precisely the ones a Defect
 * is raised against — was withheld from a picker whose own server would have taken it.
 *
 * Same class of fault as `listAssignmentOptions`' old `state IN ('planning','committed')` filter
 * (P6-VEL-004): a feed narrower than the write it feeds. CLAUDE.md records the rule that settles
 * both — "an iteration is assignable by SCOPE, never by LIFECYCLE" — and this is its Story analogue.
 *
 * WHY THIS FILE AND NOT A SERVICE SPEC
 * The population is the whole property. `work-items.service.spec.ts` mocks the repository, so it
 * cannot see which rows a predicate admits; `route-policy.ratchet.spec.ts` reads source text, so it
 * cannot see a feed at all. CLAUDE.md states it twice: "a spec that calls a service directly cannot
 * see a guard defect", and a decorator is a note, not a check.
 *
 * The session cookie from identity's test-login (`support/session.ts`). The test
 * app has no `/v1` prefix and no cookie plugin (`reply.setCookie is not a function`).
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/api/src/app.module';
import {
  NXP_ACCEPTED_STORY_ID,
  NXP_DEFECT_1_ID,
  NXP_STORY_1_ID,
  NXP_STORY_2_ID,
  NXP_STORY_3_ID,
  PAY_STORY_ID,
  SEED_PROJECTS,
} from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;
const PAY = SEED_PROJECTS[1].id;

interface StoryOption {
  id: string;
  itemKey: string;
  title: string;
  projectId: string;
}

describe('the Parent Story reference feed (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function tokenFor(email: string): Promise<string> {
    const accessToken = await signIn(app, email);
    expect(accessToken, `test-login for ${email}`).toBeTruthy();
    return accessToken;
  }

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  async function options(projectId: string, token: string): Promise<StoryOption[]> {
    const response = await get(`/work-items/story-options?projectId=${projectId}`, token);
    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    return JSON.parse(response.body) as StoryOption[];
  }

  /**
   * The BA's repro, as a population claim.
   *
   * `US-1` (`NXP_STORY_1_ID`) and `US-D1` (`NXP_STORY_2_ID`) both sit in the committed Sprint 25.13,
   * and `US-3` (`NXP_ACCEPTED_STORY_ID`) is ACCEPTED inside the finished Sprint 25.12. Under the old
   * feed all three were absent and `US-D2` alone remained — one option, out of four Stories, on a
   * screen whose own server would have accepted any of them.
   *
   * The accepted one is asserted deliberately: a Defect is most often raised AGAINST shipped work,
   * so filtering the picker by schedule state would withhold the commonest parent of all.
   */
  it('offers SCHEDULED and ACCEPTED Stories, not just the unscheduled Backlog', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    const ids = (await options(NXP, admin)).map((s) => s.id);

    for (const [label, id] of [
      ['US-1, in the committed sprint', NXP_STORY_1_ID],
      ['US-D1, in the committed sprint', NXP_STORY_2_ID],
      ['US-3, accepted in the finished sprint', NXP_ACCEPTED_STORY_ID],
      ['US-D2, unscheduled', NXP_STORY_3_ID],
    ] as const) {
      expect(
        ids,
        `${label} must be offered as a Parent Story — the write path accepts it, so the picker ` +
          'cannot withhold it (the Backlog feed did, via `iteration_id IS NULL`)',
      ).toContain(id);
    }
  });

  /** Stories only, and only this project's — the two rules `updateWorkItem` refuses on. */
  it('excludes other projects and every non-Story type', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    const rows = await options(NXP, admin);

    expect(rows.map((s) => s.id)).not.toContain(PAY_STORY_ID);
    expect(rows.map((s) => s.id)).not.toContain(NXP_DEFECT_1_ID);
    for (const row of rows) {
      expect(row.projectId, 'every option must bind in the requested project').toBe(NXP);
      expect(row.itemKey.startsWith('US-'), `${row.itemKey} is not a User Story`).toBe(true);
    }

    // The second project answers its own population, so the filter is a predicate and not an
    // accident of the fixture having one project's rows.
    const pay = await options(PAY, admin);
    expect(pay.map((s) => s.id)).toContain(PAY_STORY_ID);
    expect(pay.map((s) => s.id)).not.toContain(NXP_STORY_1_ID);
  });

  /**
   * The feed is a read over work rows, so it takes the Editor Team boundary (BA ruling 2026-08-17,
   * which names pickers explicitly). `dev@qnsc.dev` is a real per-project Editor on NXP, rostered on
   * Team Alpha only.
   *
   * Offering more would hand them a link whose target their own detail page then refuses — `US-3`
   * carries NO team, which is the Project Backlog (`PROJECT_BACKLOG_ADMIN_ONLY`), and `US-D2` is
   * Team Beta's (`TEAM_NOT_IN_SCOPE`). Both are visible to the admin above, which is what makes this
   * a boundary rather than an empty fixture.
   */
  it("narrows to an Editor's OWN teams, admin-only rows excluded", async () => {
    const editor = await tokenFor('dev@qnsc.dev');
    const ids = (await options(NXP, editor)).map((s) => s.id);

    expect(ids, "Team Alpha's own Story must be offered").toContain(NXP_STORY_1_ID);
    expect(ids, "Team Alpha's second Story must be offered").toContain(NXP_STORY_2_ID);
    expect(ids, 'a team-less Story is the Project Backlog, admin-only').not.toContain(
      NXP_ACCEPTED_STORY_ID,
    );
    expect(ids, "another team's Story is out of an Editor's scope").not.toContain(NXP_STORY_3_ID);
  });

  /**
   * The OTHER direction of that agreement, and the half a narrowed feed cannot enforce by itself:
   * a Story the picker withholds is a Story the WRITE refuses.
   *
   * Without this an Editor could name `US-3` (no Team — the Project Backlog) or `US-D2`
   * (Team Beta's) by passing its id, and the Defect would then render a key and title belonging to a
   * record they cannot open — a disclosure through a link, and the exact inverse of the fault that
   * made this feed too narrow. `DE-1` is Team Alpha's, so the Editor genuinely may edit it: the
   * refusal is about the PARENT, not about reaching the Defect.
   *
   * A 403 with the boundary's own two codes, deliberately not one: "this is the Project Backlog" and
   * "this is another Team's record" are different facts, and only one is something the reader can
   * act on.
   */
  it('REFUSES an Editor a parent the picker does not offer', async () => {
    const editor = await tokenFor('dev@qnsc.dev');
    const offered = (await options(NXP, editor)).map((s) => s.id);

    for (const [parentId, code, label] of [
      [NXP_ACCEPTED_STORY_ID, 'PROJECT_BACKLOG_ADMIN_ONLY', 'a team-less Story (Project Backlog)'],
      [NXP_STORY_3_ID, 'TEAM_NOT_IN_SCOPE', "another Team's Story"],
    ] as const) {
      expect(offered, `${label} must not be offered`).not.toContain(parentId);

      const response = await app.inject({
        method: 'PATCH',
        url: `/work-items/${NXP_DEFECT_1_ID}`,
        headers: { cookie: editor },
        payload: { parentId },
      });
      expect(response.statusCode, `${label} — ${response.body.slice(0, 200)}`).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe(code);
    }
  });

  /**
   * The feed and the write agree, which is the property the whole change exists for: an option the
   * picker offers must be one `PATCH /work-items/:id` accepts.
   *
   * `DE-1` is Team Alpha's Defect in the committed sprint and `US-1` is a Story in that SAME sprint —
   * exactly the pair the old feed could not express. Restored afterwards so the shared fixture is
   * unchanged for every other file (`DE-1` is seeded parented to `US-1`).
   */
  it('accepts an offered Story as a Defect parent, and shows it back', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    const offered = await options(NXP, admin);
    expect(offered.map((s) => s.id)).toContain(NXP_STORY_1_ID);

    async function setParent(parentId: string | null) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/work-items/${NXP_DEFECT_1_ID}`,
        headers: { cookie: admin },
        payload: { parentId },
      });
      expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
      return JSON.parse(response.body) as { parentId: string | null };
    }

    expect((await setParent(null)).parentId).toBeNull();
    expect(
      (await setParent(NXP_STORY_1_ID)).parentId,
      'a Story the picker offers must be a legal parent — otherwise the feed is describing a rule ' +
        'the server does not have',
    ).toBe(NXP_STORY_1_ID);

    const reread = await get(`/work-items/${NXP_DEFECT_1_ID}`, admin);
    expect(reread.statusCode, reread.body.slice(0, 200)).toBe(200);
    expect((JSON.parse(reread.body) as { parentId: string | null }).parentId).toBe(NXP_STORY_1_ID);
  });
});

/**
 * `GET /work-items/:id/split-preview` over REAL HTTP (Phase 7 SU-01).
 *
 * What a service-level spec cannot see, and why this file exists:
 *   • the route carries a REAL `@RequirePermission('work_item:view', { resource: 'work_item', … })`
 *     whose project scope is resolved by loading the row — `route-policy.ratchet.spec.ts` reads SOURCE
 *     TEXT and cannot tell a correct decorator from a misspelled code or a wrong scope field;
 *   • the response passes through the `nestjs-zod` serializer, so a DTO that cannot be represented in
 *     JSON Schema, or a field the schema strips, shows up here and nowhere else.
 *
 * Uses the SEEDED fixtures (`NXP_STORY_1`, `Sprint 26.1` → `Sprint 26.2`) — `test/e2e-fixtures.ratchet.spec.ts`
 * caps `createProject`, and the plan's §6 PR 1.12 verified against a live database that this fixture
 * already supports a split. Two throwaway Stories are created INSIDE NXP for the two ineligibility
 * cases the seed has no row for; creating work items is not what the ratchet counts.
 *
 * NO `/v1` PREFIX. `Test.createTestingModule` builds the app without the bootstrap that sets the
 * global prefix, so routes are mounted bare here — the served spec says `/v1/...` for the real app.
 * Getting this wrong reads as a 404, which is why the assertions below distinguish 200 from 403 from
 * 404 rather than asserting "not an error".
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_LEVEL_PERMISSIONS,
  PERMISSION,
  ROLE_PERMISSIONS,
  SYSTEM_ROLE,
} from '@shared-kernel';
import { WorkItemsService } from '@modules/work-items';
import type { JwtPayload } from '@platform';
import { AppModule } from '../../apps/api/src/app.module';
import {
  NXP_ACCEPTED_STORY_ID,
  NXP_DEFECT_1_ID,
  NXP_ITER_CURRENT_ID,
  NXP_ITER_FUTURE_ID,
  NXP_STORY_1_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
} from '../../db/seeds/constants';
import { adminActor } from './support/flow-harness';

const NXP = SEED_PROJECTS[0].id;

interface PreviewBody {
  eligible: boolean;
  ineligibleReason: string | null;
  story: {
    id: string;
    itemKey: string;
    title: string;
    planEstimate: number | null;
    iterationId: string | null;
    iterationName: string | null;
    releaseId: string | null;
    releaseName: string | null;
    teamId: string | null;
  };
  targets: Array<{ id: string; name: string; state: string; startDate: string | null }>;
  defaults: { unfinishedTitle: string; continuedTitle: string; targetIterationId: string | null };
  tasks: Array<{ itemKey: string; state: string; defaultSide: string; todoHours: number | null }>;
  defects: Array<{
    itemKey: string;
    defaultSide: string;
    explicitIterationId: string | null;
    explicitIterationName: string | null;
  }>;
  testCases: Array<{ testCaseKey: string; defaultSide: string; lastVerdict: string | null }>;
}

describe('split preview route (e2e)', () => {
  let app: NestFastifyApplication;
  let token: string;
  let actor: JwtPayload;
  /** A Story with no Iteration — the `unscheduled` case, which the seed has no row for. */
  let unscheduledStoryId: string;
  /** A Story in the LATEST Iteration, so nothing is later than it — the `no_target` case. */
  let lastIterationStoryId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EntraTokenVerifier)
      .useValue({
        verify: async (idToken: string): Promise<EntraClaims> => JSON.parse(idToken) as EntraClaims,
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Bearer, not the BFF cookie: `requiresCsrfProtection` exempts Bearer callers, and the test app
    // has no cookie plugin registered (`reply.setCookie is not a function`).
    token = (await app.get(AuthService).devLogin('admin@qnsc.dev', '127.0.0.1')).accessToken;
    actor = adminActor();

    const workItems = app.get(WorkItemsService);
    const unscheduled = await workItems.createWorkItem(actor, NXP, 'story', 'SU-01 unscheduled', {
      teamId: TEAM_ALPHA_ID,
    });
    unscheduledStoryId = unscheduled.id;

    // `Sprint 26.2` (`NXP_ITER_FUTURE_ID`, 2026-06-29 → 07-10) is the LAST seeded iteration, so a
    // Story sitting in it has no strictly-later window to move to (§8 Q3).
    const lastIteration = await workItems.createWorkItem(actor, NXP, 'story', 'SU-01 last sprint', {
      teamId: TEAM_ALPHA_ID,
      iterationId: NXP_ITER_FUTURE_ID,
    });
    lastIterationStoryId = lastIteration.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  function preview(id: string) {
    return app.inject({
      method: 'GET',
      url: `/work-items/${id}/split-preview`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function body(id: string): Promise<PreviewBody> {
    const response = await preview(id);
    expect(response.statusCode, response.body).toBe(200);
    return JSON.parse(response.body) as PreviewBody;
  }

  // ── The eligible case ───────────────────────────────────────────────────────

  it('answers 200 and `eligible: true` for the seeded Story (AC3–AC6)', async () => {
    const result = await body(NXP_STORY_1_ID);
    expect(result.eligible).toBe(true);
    expect(result.ineligibleReason).toBeNull();
  });

  it('names the Story with the SAME field names the rest of the work-item contract uses', async () => {
    // `title`, not `name`: `work_items.title` is the column and every other work-item payload says
    // `title`. A split payload that disagreed would be a trap for the generated client.
    //
    // The VALUE is read back from `GET /work-items/:id` rather than pinned to a literal. US-1 is a
    // shared fixture and other specs in this suite legitimately rename it and re-point its estimate —
    // this suite has documented cross-test data pollution — so a literal here fails for a reason that
    // has nothing to do with Split. Comparing the two routes is the stronger assertion anyway: it
    // proves the two payloads describe the same row in the same vocabulary.
    const result = await body(NXP_STORY_1_ID);
    const record = await app.inject({
      method: 'GET',
      url: `/work-items/${NXP_STORY_1_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const item = JSON.parse(record.body) as {
      itemKey: string;
      title: string;
      storyPoints: number | null;
      teamId: string | null;
    };

    expect(result.story.itemKey).toBe(item.itemKey);
    expect(result.story.title).toBe(item.title);
    // The BA calls it Plan Estimate; the column is `story_points` (D2, no new column).
    expect(result.story.planEstimate).toBe(item.storyPoints);
    expect(result.story.teamId).toBe(item.teamId);
    // The Iteration is the one fact the Split rules turn on, and no other spec moves US-1 out of the
    // active sprint, so it stays pinned.
    expect(result.story.iterationId).toBe(NXP_ITER_CURRENT_ID);
    expect(result.story.iterationName).toBe('Sprint 26.1');
  });

  it('resolves the Release NAME from the row, not from a release feed', async () => {
    // An Editor holds no `release:view`, so a name sourced from an offer list would be absent for
    // exactly the callers who own the Story — the incident `CLAUDE.md` records as a released item
    // rendering as unscheduled.
    const result = await body(NXP_STORY_1_ID);
    expect(result.story.releaseId).not.toBeNull();
    expect(result.story.releaseName).toBeTruthy();
  });

  it('§8 Q2/Q3: offers the team-LESS later sprint, and neither the source nor the accepted past one', async () => {
    // The ruling this feature turns on, asserted against a live database. `Sprint 26.2` is team-less
    // and the Story is Team Alpha; under the mockup\u2019s strict team equality the answer would be an
    // empty list and the whole feature would be undemonstrable on a fresh database.
    const result = await body(NXP_STORY_1_ID);
    const names = result.targets.map((target) => target.name);

    expect(names).toContain('Sprint 26.2');
    // The source itself is not a target — moving a Story to the sprint it occupies is not a Split.
    expect(names).not.toContain('Sprint 26.1');
    // `Sprint 25.12` is both EARLIER and `accepted`; two independent predicates refuse it, which is
    // why the unit spec asserts each on its own (`split-story.spec.ts`).
    expect(names).not.toContain('Sprint 25.12');
    // No `accepted` iteration may be a target, whatever the seed grows to hold.
    expect(result.targets.every((target) => target.state !== 'accepted')).toBe(true);
  });

  it('returns targets EARLIEST FIRST and defaults to the earliest (BR-06)', async () => {
    const result = await body(NXP_STORY_1_ID);
    const starts = result.targets.map((target) => target.startDate);
    expect([...starts].sort()).toEqual(starts);
    expect(result.defaults.targetIterationId).toBe(result.targets[0].id);
    expect(result.defaults.targetIterationId).toBe(NXP_ITER_FUTURE_ID);
  });

  it('defaults both titles with the prefixes, from the bare title (BR-12, §8 Q10)', async () => {
    // Derived from the response's OWN title, not a literal: the prefix rule is what is under test,
    // and US-1's title is shared mutable fixture state. `stripSplitPrefix` is applied here too, so a
    // Story another spec has left named `[Continued] x` still asserts the no-stacking rule.
    const result = await body(NXP_STORY_1_ID);
    const bare = result.story.title.replace(/^\[(Continued|Unfinished)\]\s*/i, '');
    expect(result.defaults.unfinishedTitle).toBe(`[Unfinished] ${bare}`);
    expect(result.defaults.continuedTitle).toBe(`[Continued] ${bare}`);
    // And the prefixes never stack, whatever the title arrived as.
    expect(result.defaults.unfinishedTitle).not.toMatch(
      /\[Unfinished\].*\[(Continued|Unfinished)\]/i,
    );
    expect(result.defaults.continuedTitle).not.toMatch(
      /\[Continued\].*\[(Continued|Unfinished)\]/i,
    );
  });

  it('BR-14: EVERY Completed Task defaults LEFT and every other Task RIGHT', async () => {
    /**
     * The rule stated over whatever set is present, rather than three pinned keys. Other specs in this
     * suite edit these Tasks (`story-task-hours`, `derived-invariants`, the Team Status writes), so
     * `TA-1 === 'unfinished'` is a claim about execution order; `state === 'completed' ⇔ side ===
     * 'unfinished'` is the claim BR-14 actually makes, and it cannot pass vacuously because the
     * emptiness of the set is asserted separately below.
     */
    const result = await body(NXP_STORY_1_ID);
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      const expected = task.state === 'completed' ? 'unfinished' : 'continued';
      expect(task.defaultSide, `${task.itemKey} is ${task.state}`).toBe(expected);
    }
    // The seeded fixture, verified live on 2026-09-16, has both kinds — so the rule above is exercised
    // in both directions on a fresh database. Asserted as a SET property, so a later edit to one Task
    // does not fail the test for the wrong reason.
    const states = new Set(result.tasks.map((task) => task.state));
    expect(states.size, 'the fixture should exercise more than one Task state').toBeGreaterThan(1);
  });

  it('carries each Task\u2019s hours, so SU-02\u2019s footer arithmetic has real numbers', async () => {
    // The three hour fields are INDEPENDENT (Portfolio SRS) and Split must not derive one from
    // another. What is asserted here is that each is CARRIED — present and numeric-or-null — not what
    // any particular Task holds, which other specs edit.
    const result = await body(NXP_STORY_1_ID);
    for (const task of result.tasks) {
      for (const field of ['todoHours', 'estimateHours', 'actualHours'] as const) {
        const value = task[field as 'todoHours'];
        expect(value === null || typeof value === 'number', `${task.itemKey}.${field}`).toBe(true);
      }
    }
    expect(result.tasks.some((task) => typeof task.todoHours === 'number')).toBe(true);
  });

  it('BR-15/BR-18: the child Defect defaults RIGHT, and its OWN Iteration is reported, never derived', async () => {
    const result = await body(NXP_STORY_1_ID);
    const defect = result.defects.find((row) => row.itemKey === 'DE-1');
    expect(defect, 'DE-1 is a seeded child of US-1').toBeDefined();
    expect(defect?.defaultSide).toBe('continued');
    /**
     * BR-18 — reported, never written, and §8 Q8 rules the unscheduled case a NO-OP: Split does not
     * set an unscheduled Defect's Iteration, so such a Defect appears in no Iteration report either
     * before or after. The contract claim is therefore the NAME RESOLUTION: a name exactly when there
     * is an id. Pinning `Sprint 26.1` would instead pin whichever iteration the last spec left DE-1 in.
     */
    for (const row of result.defects) {
      expect(row.explicitIterationName === null).toBe(row.explicitIterationId === null);
    }
  });

  it('BR-15: every linked Test Case defaults RIGHT, with the trigger-maintained verdict', async () => {
    // CONTAINMENT, not exact-set equality: other specs in this suite create and delete Test Cases on
    // US-1 (`test-case-routes.e2e.spec.ts` does both), so pinning the array is a dependency on
    // execution order rather than on the rule. What BR-15 actually claims is that EVERY Test Case
    // defaults to `[Continued]`, and that is asserted over whatever set is present.
    const result = await body(NXP_STORY_1_ID);
    const keys = result.testCases.map((row) => row.testCaseKey);
    expect(keys).toContain('TC-1');
    expect(keys).toContain('TC-2');
    expect(result.testCases.every((row) => row.defaultSide === 'continued')).toBe(true);
    // TC-1 has Results, TC-2 has none — `null` is a FACT ("no Result yet"), rendered as Not Run, and
    // never `0`. Both are the trigger's answer (`trg_test_case_last_result`), read from the column.
    expect(result.testCases.find((row) => row.testCaseKey === 'TC-1')?.lastVerdict).toBe('pass');
    expect(result.testCases.find((row) => row.testCaseKey === 'TC-2')?.lastVerdict).toBeNull();
  });

  it('reads the Test Cases through the bound repository, not TestCasesService', async () => {
    // Structural, and worth pinning: `TestCasesModule` imports `WorkItemsModule`, so a
    // service-to-service dependency the other way is a real NestJS module cycle (plan D1). If someone
    // "simplifies" this to `TestCasesService`, the app fails to BOOT — so this request answering with
    // the seeded rows at all is the assertion.
    const result = await body(NXP_STORY_1_ID);
    expect(result.testCases.length).toBeGreaterThanOrEqual(2);
  });

  // ── The five ineligibility reasons, one test each ───────────────────────────

  it('BR-01: a Defect is `not_a_story`', async () => {
    const result = await body(NXP_DEFECT_1_ID);
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe('not_a_story');
  });

  it('BR-02: an accepted Story is `finished_state`', async () => {
    // US-3, seeded `accepted` with an explicit `accepted_date` inside the past sprint.
    const result = await body(NXP_ACCEPTED_STORY_ID);
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe('finished_state');
  });

  it('BR-03: a Story with no Iteration is `unscheduled`', async () => {
    const result = await body(unscheduledStoryId);
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe('unscheduled');
  });

  it('BR-05/06: a Story in the LAST Iteration is `no_target`', async () => {
    // Nothing is strictly later than `Sprint 26.2`, so the valid-target set is empty and the Story
    // cannot be split however healthy it otherwise looks.
    const result = await body(lastIterationStoryId);
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe('no_target');
    expect(result.targets).toEqual([]);
    expect(result.defaults.targetIterationId).toBeNull();
  });

  it('`not_editable` is UNREACHABLE through the shipped role catalogue — recorded, not skipped', async () => {
    /**
     * The fifth reason has no e2e case, and the reason is a fact about the catalogue rather than a gap
     * in this file: EVERY permission set that grants `work_item:view` also grants `work_item:edit`.
     * `ACCESS_LEVEL_PERMISSIONS.editor` IS `ROLE_PERMISSIONS[PROJECT_MEMBER]`, and both tier roles
     * carry the pair — so there is no principal who can OPEN a Story and not edit it, and no grant
     * that could be arranged to produce one without inventing a role the product does not have.
     *
     * The branch stays in the service deliberately: it is the answer if a read-only level is ever
     * reintroduced (the retired `Viewer`), and a route that silently 403'd instead would make "you may
     * not split this" indistinguishable from "this cannot be split". Asserted as an invariant so this
     * claim FAILS the day it stops being true and a real case becomes writable.
     */
    const grantsView = [
      ROLE_PERMISSIONS[SYSTEM_ROLE.PROJECT_MEMBER],
      ROLE_PERMISSIONS[SYSTEM_ROLE.PROJECT_ADMIN],
      ACCESS_LEVEL_PERMISSIONS.editor,
      ACCESS_LEVEL_PERMISSIONS.admin,
    ];
    for (const permissions of grantsView) {
      expect(permissions).toContain(PERMISSION.WORK_ITEM_VIEW);
      expect(permissions).toContain(PERMISSION.WORK_ITEM_EDIT);
    }
  });

  // ── Shape stability ─────────────────────────────────────────────────────────

  it('keeps the SAME shape when ineligible — empty collections, never absent keys', async () => {
    // A nullable `story` or optional arrays would make every consumer branch twice for a modal that
    // never opens in that case.
    const result = await body(NXP_DEFECT_1_ID);
    expect(result.story.itemKey).toBe('DE-1');
    expect(result.targets).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.defects).toEqual([]);
    expect(result.testCases).toEqual([]);
    expect(result.defaults.unfinishedTitle).toContain('[Unfinished] ');
  });

  it('404s for a work item that does not exist', async () => {
    const response = await preview('00000000-0000-7000-8000-0000000000ff');
    expect(response.statusCode).toBe(404);
  });
});

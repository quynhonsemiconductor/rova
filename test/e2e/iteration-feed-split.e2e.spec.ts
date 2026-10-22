/**
 * `GET /iterations` answers a DIFFERENT question from the two compact feeds, and its audience is
 * different too. Over real HTTP, in both directions, with a real per-project Editor.
 *
 * THE DEFECT (the unfinished half of RBE-09 / P23-08 / P01-11)
 * `iteration:view` is a code EVERY per-project access level holds, and an Editor must hold it:
 * Iteration Status, the Backlog's iteration filter, Team Status and Quality all need to name an
 * iteration, and §3.2 grants an Editor all four surfaces. But `GET /iterations` returns the timebox
 * RECORD — `goal`, `theme`, `notes`, `plannedVelocity` — and §3.2 marks `Plan > Timeboxes` **Hidden**
 * for an Editor, which is the entire reason `timebox:view` exists. The first split separated the
 * SURFACE (`GET /iterations/:id` and its revision history) and left the FEED behind, so the Editor
 * went on reading the record from the list.
 *
 * WHY TWO NEW ROUTES AND NOT ONE FLAG
 * Two questions were conflated in one endpoint:
 *   • REFERENCE   "what is this iteration called, and when was it?"  every state, plus `teamId`
 *   • ELIGIBILITY "which iterations may I assign work INTO?"         every state, no `teamId`
 * `GET /iterations/options` used to answer the second, which is exactly why the pickers could not use
 * it — an ACCEPTED iteration must still resolve to a name, and it could not offer one. A
 * `?includeAllStates` flag would have let one caller measure a population while a sibling caller
 * enumerated another; CLAUDE.md records that conflation producing zero-point Velocity bars, so
 * `/options` took the REFERENCE meaning it already carries for releases, milestones, portfolio items
 * and member options, and eligibility moved to `/assignable`.
 *
 * Eligibility's `planning | committed` predicate is GONE (P6-VEL-004, BA retest 2026-08-17) — it never
 * matched the write rule, and the test below asserts the reverse of what it once did.
 *
 * WHAT THIS FILE ADDS OVER THE SPECS THAT ALREADY EXIST
 *   • `test/iteration-timebox-gate.spec.ts` reads decorator METADATA. It cannot see a `scope` that
 *     resolves the project from the wrong field, and CLAUDE.md records twice that "a spec that calls
 *     a service directly cannot see a guard defect".
 *   • `test/route-audience.ratchet.spec.ts` reads the response DTO's zod shape. It proves the
 *     reference schema declares no administration field; it cannot prove the HANDLER returns that
 *     schema, and a mapper that spread the row would satisfy it.
 *   • `test/e2e/authz-cluster.e2e.spec.ts` holds the gate half of the §3.2 rows. This file holds the
 *     POPULATION half, which is the property the split exists for and which no gate test can see.
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
  NXP_ITER_CURRENT_ID,
  NXP_ITER_PAST_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
} from '../../db/seeds/constants';
import { signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

/**
 * The four fields that make `GET /iterations` administrative. `theme` is included even though
 * `route-audience.ratchet.spec.ts` deliberately leaves it out of `RECORD_ADMIN_FIELDS` (it adds no
 * coverage there, because every schema carrying it also carries `goal` or `notes`) — here it costs
 * nothing and it is one of the four §3.2 names.
 */
const RECORD_ONLY_FIELDS = ['goal', 'theme', 'notes', 'plannedVelocity'] as const;

/** Exactly what the reference projection is allowed to be. Asserted as a SET, not a subset. */
const REFERENCE_FIELDS = [
  'id',
  'name',
  'iterationKey',
  'state',
  'startDate',
  'endDate',
  'teamId',
] as const;

interface CompactIteration {
  id: string;
  state: string;
}

describe('the iteration feed split (e2e)', () => {
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

  const RECORD = `/iterations?projectId=${NXP}`;
  const REFERENCE = `/iterations/options?projectId=${NXP}`;
  const ELIGIBILITY = `/iterations/assignable?projectId=${NXP}`;

  /**
   * `dev@qnsc.dev` is a real per-project Editor: `work.project_members.access_level = 'editor'` on
   * NXP and NO workspace-scoped tier role (migration 0111/0112, and the comment in `demo.ts`). Not a
   * principal whose baseline masks the check — which is how the `report:view` defect survived to
   * migration 0092. Every request here is a read, so the shared fixture is not mutated.
   */
  it('REFUSES an Editor the timebox record and ALLOWS both compact feeds', async () => {
    const editor = await tokenFor('dev@qnsc.dev');

    // 403, not 404 or 400: the project exists and the caller is identified, so it is the PERMISSION
    // that is missing. A 404 would mean the guard resolved the wrong project from `?projectId`.
    const record = await get(RECORD, editor);
    expect(record.statusCode, `${RECORD} must be refused to an Editor — ${record.body}`).toBe(403);

    for (const url of [REFERENCE, ELIGIBILITY]) {
      const response = await get(url, editor);
      expect(
        response.statusCode,
        `${url} must stay open to an Editor — ${response.body.slice(0, 200)}`,
      ).toBe(200);
    }
  });

  /**
   * The other direction, and it is not decoration: a "fix" that hid the record by revoking
   * `iteration:view` from the Editor would pass the refusal above and fail this — 403ing Iteration
   * Status, the Backlog filter, Team Status and Quality, which is what made revocation unavailable
   * the first time. A feed nobody can read is indistinguishable, on screen, from never having split
   * anything: the SPA renders an empty list as "there are none".
   */
  it('ALLOWS a Workspace Admin all three', async () => {
    const admin = await tokenFor('admin@qnsc.dev');

    for (const url of [RECORD, REFERENCE, ELIGIBILITY]) {
      const response = await get(url, admin);
      expect(
        response.statusCode,
        `${url} must be readable by a Workspace Admin — ${response.body.slice(0, 200)}`,
      ).toBe(200);
    }
  });

  /**
   * A CLOSED timebox is named by the reference feed AND offered by the eligibility one — the
   * behaviour half, which no gate test can see.
   *
   * `NXP_ITER_PAST_ID` is Sprint 25.12: `state: 'accepted'`, with a `goal` and a `plannedVelocity`
   * of 18 (`db/seeds/reference-extras.ts`). It must be PRESENT in `/options`, because an item
   * scheduled into it still has to render its name once the sprint closes — reusing the eligibility
   * feed for that rendered `--` for a genuinely scheduled item (RELATION_DATA_TRACEABILITY.md), which
   * is why six SPA call sites read the RECORD instead and why this endpoint had to exist before the
   * record could be gated.
   *
   * It must ALSO be present in `/assignable`, and this assertion is REVERSED from what it was
   * (P6-VEL-004, BA retest 2026-08-17). Eligibility used to stop at `planning | committed`, which
   * never matched the write: `assertIterationAssignable` reads `project_id` and `team_id` and no
   * state, so the API accepted a closed target the picker refused to offer. Velocity attributes points
   * by the item's CURRENT iteration, so moving a Story out of a finished sprint changed its bar and
   * nothing could put it back. Assignability is a scope question, not a lifecycle one.
   */
  it('names an ACCEPTED iteration in the REFERENCE feed and OFFERS it in the ELIGIBILITY one', async () => {
    const editor = await tokenFor('dev@qnsc.dev');

    const reference = await get(REFERENCE, editor);
    expect(reference.statusCode, reference.body).toBe(200);
    const references = JSON.parse(reference.body) as CompactIteration[];

    const eligibility = await get(ELIGIBILITY, editor);
    expect(eligibility.statusCode, eligibility.body).toBe(200);
    const assignable = JSON.parse(eligibility.body) as CompactIteration[];

    for (const [label, rows] of [
      ['reference', references],
      ['eligibility', assignable],
    ] as const) {
      const accepted = rows.find((i) => i.id === NXP_ITER_PAST_ID);
      expect(
        accepted,
        `the accepted Sprint 25.12 must appear in the ${label} feed — a closed timebox still has a ` +
          'name and is still a legal assignment target (P6-VEL-004)',
      ).toBeTruthy();
      expect(accepted!.state).toBe('accepted');

      // And the committed one too, so the assertions above are about a POPULATION and not about one
      // feed happening to return everything because it returns nothing selective.
      expect(
        rows.some((i) => i.id === NXP_ITER_CURRENT_ID),
        `the committed Sprint 26.1 must appear in the ${label} feed`,
      ).toBe(true);
    }
  });

  /**
   * The payload contract, measured on the WIRE rather than on the zod shape.
   *
   * `route-audience.ratchet.spec.ts` proves `IterationReferenceSchema` declares none of these four;
   * it cannot prove the handler returns that schema. A mapper written as `{ ...row }` — which is what
   * the record's own mapper looks like — would keep that ratchet green and put `goal`, `theme`,
   * `notes` and `plannedVelocity` back on a feed every access level reads. Sprint 25.12 has all four
   * populated in the seed, so this is a live check and not a check against nulls.
   */
  it('keeps the timebox RECORD out of the reference payload', async () => {
    const editor = await tokenFor('dev@qnsc.dev');

    const reference = await get(REFERENCE, editor);
    expect(reference.statusCode, reference.body).toBe(200);
    const rows = JSON.parse(reference.body) as Record<string, unknown>[];
    expect(rows.length, 'the seeded NXP project has iterations').toBeGreaterThan(0);

    for (const row of rows) {
      const leaked = RECORD_ONLY_FIELDS.filter((field) => field in row);
      expect(
        leaked,
        `GET /iterations/options returned administration field(s) ${leaked.join(', ')} on ` +
          `iteration ${String(row.id)}. §3.2 hides Plan > Timeboxes from an Editor and this feed is ` +
          `iteration:view, which every access level holds.`,
      ).toEqual([]);

      // An EXACT key set, not a subset: "no record field today" is what a `.pick()` also satisfies,
      // and the whole reason the reference schema is declared in full is that the NEXT field added
      // to the grid must not be able to arrive here.
      expect([...Object.keys(row)].sort()).toEqual([...REFERENCE_FIELDS].sort());
    }

    // The record list, for the same project, DOES carry them — so the assertion above is about this
    // projection and not about the seed having left the fields empty.
    const admin = await tokenFor('admin@qnsc.dev');
    const record = await get(RECORD, admin);
    expect(record.statusCode, record.body).toBe(200);
    const page = JSON.parse(record.body) as { data: Record<string, unknown>[] };
    const past = page.data.find((i) => i.id === NXP_ITER_PAST_ID);
    expect(past, 'Sprint 25.12 is on the record list').toBeTruthy();
    expect(past!.goal, 'the seeded goal is what the reference feed must not carry').toBeTruthy();
    expect(past!.plannedVelocity).toBe(18);
  });

  /**
   * The team predicate on BOTH compact feeds is the team's OWN timeboxes PLUS the project's shared
   * ones — `teamOrSharedTimebox`, the server half of `iterationsInScope`.
   *
   * `iterations.team_id` is optional in this product (the timebox says WHICH window, the work says
   * whose it is), so most iterations name no team and belong to every team in the project — all three
   * seeded NXP iterations are shared. A strict `team_id = ?` therefore returns NOTHING here, because
   * SQL equality never matches NULL, and a team-scoped picker comes back EMPTY. That is the exact
   * failure `GET /iterations`' own `teamId` filter still has, and the reason this test asks for a
   * team rather than trusting the unscoped call.
   */
  it('offers a team the shared timeboxes as well as its own, on both feeds', async () => {
    const editor = await tokenFor('dev@qnsc.dev');

    for (const [label, url] of [
      ['reference', `${REFERENCE}&teamId=${TEAM_ALPHA_ID}`],
      ['eligibility', `${ELIGIBILITY}&teamId=${TEAM_ALPHA_ID}`],
    ] as const) {
      const response = await get(url, editor);
      expect(response.statusCode, `${url} — ${response.body.slice(0, 200)}`).toBe(200);
      const rows = JSON.parse(response.body) as CompactIteration[];
      expect(
        rows.some((i) => i.id === NXP_ITER_CURRENT_ID),
        `the ${label} feed scoped to Team Alpha must still offer the SHARED Sprint 26.1 ` +
          `(team_id IS NULL). An empty result here is the strict-equality bug.`,
      ).toBe(true);
    }
  });
});

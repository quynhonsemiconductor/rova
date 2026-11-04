import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { workspaceLocalDate } from '@platform';
import { z } from 'zod';
import {
  isRealCalendarDate,
  pathSegment,
  replayedFrom,
  result,
  toolError,
  type ToolContext,
} from './rest';
import { isDenial, resolvePeople, resolveTestCase, type LookupFailure } from './lookups';

/** The batch limit (design §6.5): one call records one build's run, not a regression campaign. */
const MAX_RESULTS = 20;

/** `not_run` is excluded: a Result records an outcome, never its absence (B1/D6). */
const VERDICTS = ['pass', 'fail', 'blocked', 'error', 'inconclusive'] as const;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The person's own calendar today, from THEIR timezone on `GET /v1/auth/me` — never a guessed
 * zone. A missing/blank zone falls back to UTC; an invalid one cannot throw into the tool.
 */
async function localToday(ctx: ToolContext): Promise<string> {
  const res = await ctx.callRest(ctx.principal, { method: 'GET', url: '/v1/auth/me' });
  const profile =
    res.statusCode < 400 && res.json !== null && typeof res.json === 'object'
      ? (res.json as Record<string, unknown>)
      : {};
  const zone = typeof profile['timezone'] === 'string' ? profile['timezone'] : '';
  if (zone !== '') {
    try {
      return workspaceLocalDate(new Date(), zone);
    } catch {
      // An unknown IANA zone in the profile must not fail a write: UTC is the documented floor.
    }
  }
  return workspaceLocalDate(new Date(), 'UTC');
}

/** One batch entry's outcome: the row it created, or the refusal that stopped it. */
interface ItemOutcome {
  testCaseKey: string;
  ok: boolean;
  testResultKey?: string;
  id?: string;
  verdict?: string;
  replayed?: boolean;
  statusCode?: number;
  error?: unknown;
}

/**
 * `rova_record_test_results` — record one run per test case against one build (W10), up to 20 in
 * one call. Each entry wraps `POST /v1/test-cases/:id/test-results` (test_result:create, already
 * `@UseIdempotency`) with the tester resolved through the same project picker the web uses; the
 * server still applies the one assignment-eligibility rule (`tester not assignable` comes back as
 * the REST refusal) and maintains the test case's Last Verdict through its trigger.
 *
 * ITEMS ARE INDEPENDENT: an unknown key or a refusal on one entry is reported in that entry and
 * the rest still run, because a batch of twenty results must not be all-or-nothing over a typo.
 *
 * Idempotency (design §11 amendment): each create sends the NATURAL key of its own row (test case,
 * build, run date, verdict, tester, notes) — no wall-clock bucket — so retrying the batch replays
 * the rows that already landed and runs only the one that failed, while a corrected verdict is a
 * different record rather than a refusal.
 */
export function registerRecordTestResults(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_record_test_results',
    {
      title: 'Record test results',
      description:
        "WRITES one test result per test case on one build, as you, and must be used only on the user's explicit request. `results` holds up to 20 entries (test case key, verdict, optional minutes and notes). Items are independent: the answer reports each one's status, so an unknown key or a refusal does not stop the rest. `tester` defaults to you; `runDate` defaults to your local today (YYYY-MM-DD). An identical entry returns the first result (`replayed: true`).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        build: z.string().min(1).max(255).describe('The build under test (e.g. 1.4.2)'),
        runDate: z
          .string()
          .regex(DATE_SHAPE, 'YYYY-MM-DD')
          .refine(isRealCalendarDate, 'Must be a real calendar date between 2000 and 2100')
          .optional()
          .describe('The date the tests ran (YYYY-MM-DD); defaults to your local today'),
        tester: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Tester by display name or email; defaults to you'),
        results: z
          .array(
            z.object({
              testCaseKey: z.string().min(1).max(64).describe('The test case key, e.g. TC-12'),
              verdict: z.enum(VERDICTS),
              durationMinutes: z.number().int().min(0).optional(),
              notes: z.string().max(4000).optional(),
            }),
          )
          .min(1)
          .max(MAX_RESULTS)
          .describe(`At most ${MAX_RESULTS} results per call`),
      },
    },
    async (args) => {
      if (!ctx.naturalIdempotencyKey) {
        return toolError('Writes are not enabled on this endpoint.');
      }
      const defaulted = args.runDate === undefined;
      const runDate = args.runDate ?? (await localToday(ctx));

      // A named tester is resolved ONCE per project it appears in — the feed is project-scoped.
      const testerByScope = new Map<string, { ok: true; id: string } | LookupFailure>();
      const testerFor = async (
        projectId: string,
        teamId: string | null,
      ): Promise<{ ok: true; id: string } | LookupFailure> => {
        if (args.tester === undefined) return { ok: true, id: ctx.principal.userId };
        // The feed is per ROW: the same person can be offered for one Team and not another.
        const scope = `${projectId}:${teamId ?? ''}`;
        const cached = testerByScope.get(scope);
        if (cached) return cached;
        const people = await resolvePeople(ctx, projectId, [args.tester], { teamId });
        const resolved: { ok: true; id: string } | LookupFailure = people.ok
          ? { ok: true, id: people.ids[0] }
          : people;
        testerByScope.set(scope, resolved);
        return resolved;
      };

      const items: ItemOutcome[] = [];
      const createdIds: string[] = [];

      for (const entry of args.results) {
        const testCase = await resolveTestCase(ctx, entry.testCaseKey);
        if (!testCase.ok) {
          items.push({
            testCaseKey: entry.testCaseKey,
            ok: false,
            ...(isDenial(testCase)
              ? { statusCode: testCase.statusCode, error: testCase.json }
              : { error: testCase.message }),
          });
          continue;
        }

        const tester = await testerFor(testCase.projectId, testCase.teamId);
        if (!tester.ok) {
          items.push({
            testCaseKey: testCase.testCaseKey,
            ok: false,
            ...(isDenial(tester)
              ? { statusCode: tester.statusCode, error: tester.json }
              : { error: tester.message }),
          });
          continue;
        }

        const body: Record<string, unknown> = {
          build: args.build,
          runDate,
          verdict: entry.verdict,
          testerId: tester.id,
          ...(entry.durationMinutes !== undefined
            ? { durationMinutes: entry.durationMinutes }
            : {}),
          ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
        };
        // The record's own identity: this test case, this build, this date, this verdict, this
        // tester. A retry of the batch replays it; a corrected verdict is its own record.
        const idempotencyKey = ctx.naturalIdempotencyKey('rova_record_test_results', {
          testCaseId: testCase.id,
          ...body,
        });
        const res = await ctx.callRest(ctx.principal, {
          method: 'POST',
          url: `/v1/test-cases/${pathSegment(testCase.id)}/test-results`,
          body,
          idempotencyKey,
        });
        if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
          items.push({
            testCaseKey: testCase.testCaseKey,
            ok: false,
            statusCode: res.statusCode,
            error: res.json,
          });
          continue;
        }
        const row = res.json as Record<string, unknown>;
        if (typeof row['id'] === 'string') createdIds.push(row['id']);
        items.push({
          testCaseKey: testCase.testCaseKey,
          ok: true,
          id: row['id'] as string,
          testResultKey: row['testResultKey'] as string,
          verdict: row['verdict'] as string,
          replayed: replayedFrom(res),
        });
      }

      ctx.noteWrite?.({
        targets: createdIds,
        fields: ['verdict', 'build', 'runDate'],
        count: createdIds.length,
      });

      const payload = {
        build: args.build,
        runDate,
        // Stated, so the model never has to infer which date the rows carry.
        ...(defaulted ? { runDateDefaulted: true } : {}),
        created: createdIds.length,
        failed: items.length - createdIds.length,
        results: items,
      };
      // Every entry failing is a failed call, even though each refusal is in the payload.
      if (createdIds.length === 0) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        };
      }
      return result(201, payload, payload);
    },
  );
}

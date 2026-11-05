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
 * The CALLER's own calendar today, from THEIR timezone on `GET /v1/auth/me`.
 *
 * NO SILENT FLOOR: a missing profile, an unreadable one, or one with no usable IANA zone makes
 * this return a tool error that asks for an explicit `runDate`, rather than quietly writing a UTC
 * date that may be the neighbouring day for the person recording it.
 */
type TodayOutcome =
  { ok: true; date: string; zone: string } | { ok: false; result: ReturnType<typeof toolError> };

async function localToday(ctx: ToolContext): Promise<TodayOutcome> {
  const res = await ctx.callRest(ctx.principal, { method: 'GET', url: '/v1/auth/me' });
  if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
    return {
      ok: false,
      result: toolError(
        'Pass runDate explicitly (YYYY-MM-DD): your profile could not be read, so your local today cannot be resolved.',
      ),
    };
  }
  const profile = res.json as Record<string, unknown>;
  const zone = typeof profile['timezone'] === 'string' ? profile['timezone'].trim() : '';
  if (zone === '') {
    return {
      ok: false,
      result: toolError(
        'Pass runDate explicitly (YYYY-MM-DD): your profile has no timezone, so your local today cannot be resolved.',
      ),
    };
  }
  try {
    return { ok: true, date: workspaceLocalDate(new Date(), zone), zone };
  } catch {
    return {
      ok: false,
      result: toolError(
        `Pass runDate explicitly (YYYY-MM-DD): your profile timezone "${zone}" is not a valid IANA zone.`,
      ),
    };
  }
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
 * Idempotency (design §11 amendment, revised 2026-11-04): with a `requestId`, each row's create is
 * keyed by {requestId, test case} — no wall-clock bucket, never a hash of the content, because a
 * second identical RUN of one test case on one build is legitimate. Retrying a partly-failed batch
 * with the SAME requestId replays the rows that landed and re-runs only the one that failed. With
 * no `requestId` nothing is keyed, and the description says a retry may record duplicates.
 */
export function registerRecordTestResults(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_record_test_results',
    {
      title: 'Record test results',
      description:
        "WRITES one test result per test case on one build, as you, and must be used only on the user's explicit request. `results` holds up to 20 entries (test case key, verdict, optional minutes and notes). Items are independent: the answer reports each one's status, so an unknown key or a refusal does not stop the rest. `tester` defaults to you. `runDate` is YOUR local date (the recorder's): it defaults to your local today — pass it explicitly when retrying across midnight, or when your profile has no timezone. DUPLICATES: a retry is deduplicated ONLY by `requestId` — generate one per user request and reuse the SAME value when retrying it; without one a retry records duplicates.",
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
        requestId: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A retry guard: generate once per user request and reuse the SAME value when retrying that request. Rows already recorded under this id are replayed, not duplicated; omit it and a retry may record duplicates.',
          ),
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
      if (!ctx.clientIdempotencyKey) {
        return toolError('Writes are not enabled on this endpoint.');
      }
      const defaulted = args.runDate === undefined;
      let runDate = args.runDate;
      let runDateZone: string | undefined;
      if (runDate === undefined) {
        const today = await localToday(ctx);
        if (!today.ok) return today.result;
        runDate = today.date;
        runDateZone = today.zone;
      }

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
        // Keyed by the CALLER's request id and THIS row's test case — never by the content, which
        // cannot tell a retry from a legitimate second run of the same case on the same build.
        const idempotencyKey =
          args.requestId !== undefined
            ? ctx.clientIdempotencyKey('rova_record_test_results', {
                requestId: args.requestId,
                testCaseId: testCase.id,
              })
            : undefined;
        const res = await ctx.callRest(ctx.principal, {
          method: 'POST',
          url: `/v1/test-cases/${pathSegment(testCase.id)}/test-results`,
          body,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
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
        const replayed = replayedFrom(res);
        // A replayed row already existed: it is NOT a new write, so it must not be counted as one
        // or listed as an audit target.
        if (!replayed && typeof row['id'] === 'string') createdIds.push(row['id']);
        items.push({
          testCaseKey: testCase.testCaseKey,
          ok: true,
          id: row['id'] as string,
          testResultKey: row['testResultKey'] as string,
          verdict: row['verdict'] as string,
          replayed,
        });
      }

      const replayedCount = items.filter((item) => item.ok && item.replayed === true).length;
      const recorded = createdIds.length + replayedCount;

      ctx.noteWrite?.({
        targets: createdIds,
        fields: ['verdict', 'build', 'runDate'],
        count: createdIds.length,
      });

      const payload = {
        build: args.build,
        runDate,
        // Stated, so the model never has to infer which date (and zone) the rows carry.
        ...(defaulted ? { runDateDefaulted: true, runDateZone } : {}),
        created: createdIds.length,
        // Rows this call answered from the idempotency cache: already written by the earlier call.
        replayed: replayedCount,
        failed: items.length - recorded,
        results: items,
      };
      // Every entry failing is a failed call, even though each refusal is in the payload. A batch
      // that only REPLAYED is a success: the rows exist.
      if (recorded === 0) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        };
      }
      return result(201, payload, payload);
    },
  );
}

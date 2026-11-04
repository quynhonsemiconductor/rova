import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, pathSegment, replayedFrom, result, toolError, type ToolContext } from './rest';
import { failureResult, resolvePeople, resolveTestCase, resolveWorkItem } from './lookups';

/**
 * The Test Case content fields. `CreateTestCaseSchema` deliberately does NOT carry them (BR1: every
 * content field starts blank on create), so on the create path they are applied with one follow-up
 * PATCH and reported separately — the same two-step `rova_create_work_item` uses for `featureId`.
 * Sending them in the CREATE body would be silently stripped by Zod while `changed` claimed them.
 */
const CONTENT_FIELDS = [
  'description',
  'objective',
  'preconditions',
  'validationInput',
  'validationExpectedResult',
  'postconditions',
  'notes',
] as const;

/** What the person-field resolution answers: the ids to send, or the refusal to relay. */
type PersonOutcome =
  | { ok: true; ownerId?: string | null; assigneeId?: string | null }
  | { ok: false; result: ReturnType<typeof failureResult> };

/** The record as a write answers it: the fields a model chains on, plus the derived verdict pair. */
export function shapeSavedTestCase(row: Record<string, unknown>) {
  return {
    id: row['id'],
    testCaseKey: row['testCaseKey'],
    name: row['name'],
    workItemId: row['workItemId'] ?? null,
    projectId: row['projectId'],
    teamId: row['teamId'] ?? null,
    type: row['type'],
    method: row['method'],
    priority: row['priority'],
    owner: { id: row['ownerId'] ?? null, name: row['ownerName'] ?? null },
    assignee: { id: row['assigneeId'] ?? null, name: row['assigneeName'] ?? null },
    description: row['description'] ?? null,
    objective: row['objective'] ?? null,
    preconditions: row['preconditions'] ?? null,
    validationInput: row['validationInput'] ?? null,
    validationExpectedResult: row['validationExpectedResult'] ?? null,
    postconditions: row['postconditions'] ?? null,
    notes: row['notes'] ?? null,
    lastVerdict: row['lastVerdict'] ?? null,
    lastRun: row['lastRun'] ?? null,
    updatedAt: row['updatedAt'],
  };
}

/**
 * `rova_save_test_case` — create a test case under a story/defect, or edit one by key (W9).
 *
 * Create wraps `POST /v1/work-items/:id/test-cases` (test_case:create, already `@UseIdempotency`),
 * update wraps `PATCH /v1/test-cases/:id` (test_case:edit). The server owns the rules the web
 * enforces: the Type must be one the project currently offers (otherwise the first selectable one
 * is used), Owner and Assigned To go through the one assignment-eligibility rule, and a test case is
 * readable exactly when its parent work item is.
 *
 * Idempotency (design §11 amendment): the create sends the NATURAL key of the record it asks for —
 * no wall-clock bucket — so an LLM retry replays the first row instead of adding a duplicate, while
 * a request that differs in any field is a different record. The update needs no key: a PATCH is a
 * SET.
 */
export function registerSaveTestCase(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'rova_save_test_case',
    {
      title: 'Save test case',
      description:
        "WRITES a test case as you, and must be used only on the user's explicit request. Pass `workItemKey` to CREATE one under a story/defect (name required), or `testCaseKey` (TC-12) to UPDATE one. Content fields (description, objective, preconditions, validation input/expected result, postconditions, notes) are update-only in the API, so on a create they are applied with one follow-up edit and its outcome is reported as `content`. `owner`/`assignee` are people by display name or email; pass null on an update to clear them. An identical create returns the first result (`replayed: true`).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        testCaseKey: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('UPDATE this test case, by key (e.g. TC-12)'),
        workItemKey: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('CREATE under this story/defect, by key (e.g. US-412) or id'),
        name: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Required to create; optional on update'),
        description: z.string().max(50_000).nullable().optional(),
        objective: z.string().max(50_000).nullable().optional(),
        preconditions: z.string().max(50_000).nullable().optional(),
        validationInput: z.string().max(50_000).nullable().optional(),
        validationExpectedResult: z.string().max(50_000).nullable().optional(),
        postconditions: z.string().max(50_000).nullable().optional(),
        notes: z.string().max(50_000).nullable().optional(),
        type: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe('A Test Case Type the project offers (defaults to its first one)'),
        method: z.enum(['manual', 'automated']).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        owner: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('Owner by display name or email; null clears it on an update'),
        assignee: z
          .string()
          .min(1)
          .max(255)
          .nullable()
          .optional()
          .describe('Assigned To by display name or email; null clears it on an update'),
      },
    },
    async (args) => {
      if (args.testCaseKey !== undefined && args.workItemKey !== undefined) {
        return toolError('Pass ONE of testCaseKey (update) or workItemKey (create).');
      }
      if (args.testCaseKey === undefined && args.workItemKey === undefined) {
        return toolError('Pass testCaseKey to update a test case, or workItemKey to create one.');
      }

      /** The person fields, resolved against the subject's project — a name only, never an id. */
      const personIds = async (
        projectId: string,
        teamId: string | null,
      ): Promise<PersonOutcome> => {
        const resolved: { ownerId?: string | null; assigneeId?: string | null } = {};
        for (const [reference, field] of [
          [args.owner, 'ownerId'],
          [args.assignee, 'assigneeId'],
        ] as const) {
          if (reference === undefined) continue;
          if (reference === null) {
            resolved[field] = null;
            continue;
          }
          const people = await resolvePeople(ctx, projectId, [reference], { teamId });
          if (!people.ok) return { ok: false, result: failureResult(people) };
          resolved[field] = people.ids[0];
        }
        return { ok: true, ...resolved };
      };

      if (args.testCaseKey !== undefined) {
        // ── UPDATE ───────────────────────────────────────────────────────────────
        const testCase = await resolveTestCase(ctx, args.testCaseKey);
        if (!testCase.ok) return failureResult(testCase);

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body['name'] = args.name;
        for (const field of CONTENT_FIELDS) {
          if (args[field] !== undefined) body[field] = args[field];
        }
        if (args.type !== undefined) body['type'] = args.type;
        if (args.method !== undefined) body['method'] = args.method;
        if (args.priority !== undefined) body['priority'] = args.priority;
        const people = await personIds(testCase.projectId, testCase.teamId);
        if (!people.ok) return people.result;
        if (people.ownerId !== undefined) body['ownerId'] = people.ownerId;
        if (people.assigneeId !== undefined) body['assigneeId'] = people.assigneeId;

        if (Object.keys(body).length === 0) {
          return toolError('Pass at least one field to change.');
        }

        const res = await ctx.callRest(ctx.principal, {
          method: 'PATCH',
          url: `/v1/test-cases/${pathSegment(testCase.id)}`,
          body,
        });
        if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
          return denied(res.statusCode, res.json);
        }
        const changed = Object.keys(body);
        ctx.noteWrite?.({ targets: [testCase.id], fields: changed, count: 1 });
        return result(res.statusCode, res.json, {
          testCase: shapeSavedTestCase(res.json as Record<string, unknown>),
          changed,
        });
      }

      // ── CREATE ─────────────────────────────────────────────────────────────────
      if (args.name === undefined) {
        return toolError('name is required to create a test case.');
      }
      if (!ctx.naturalIdempotencyKey) {
        return toolError('Writes are not enabled on this endpoint.');
      }
      const parent = await resolveWorkItem(ctx, args.workItemKey as string);
      if (!parent.ok) return failureResult(parent);

      const body: Record<string, unknown> = { name: args.name };
      if (args.type !== undefined) body['type'] = args.type;
      if (args.method !== undefined) body['method'] = args.method;
      if (args.priority !== undefined) body['priority'] = args.priority;
      const createPeople = await personIds(parent.projectId, parent.teamId);
      if (!createPeople.ok) return createPeople.result;
      if (createPeople.ownerId !== undefined && createPeople.ownerId !== null) {
        body['ownerId'] = createPeople.ownerId;
      }
      if (createPeople.assigneeId !== undefined && createPeople.assigneeId !== null) {
        body['assigneeId'] = createPeople.assigneeId;
      }

      // Content fields `CreateTestCaseSchema` does not carry (BR1): applied after the create.
      const content: Record<string, unknown> = {};
      for (const field of CONTENT_FIELDS) {
        const value = args[field];
        if (value !== undefined && value !== null) content[field] = value;
      }

      // The natural identity of the record asked for: everything this call would write, so an
      // identical retry replays and a request that differs in ANY field is a different record.
      const idempotencyKey = ctx.naturalIdempotencyKey('rova_save_test_case', {
        workItemId: parent.id,
        ...body,
        ...content,
      });
      const res = await ctx.callRest(ctx.principal, {
        method: 'POST',
        url: `/v1/work-items/${pathSegment(parent.id)}/test-cases`,
        body,
        idempotencyKey,
      });
      if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
        return denied(res.statusCode, res.json);
      }
      const row = res.json as Record<string, unknown>;
      const replayed = replayedFrom(res);
      const changed =
        Object.keys(content).length > 0 ? ['created', ...Object.keys(content)] : ['created'];

      // The row to answer: the create's own response until the follow-up edit replaces it with
      // the server's post-edit record (so `testCase` states what the content ACTUALLY became).
      let saved = shapeSavedTestCase(row);
      let contentOutcome: { applied: boolean | null; error?: unknown } | undefined;
      if (Object.keys(content).length > 0) {
        const createdId = typeof row['id'] === 'string' ? row['id'] : undefined;
        if (replayed) {
          // The first identical call (same content, same key) already applied it; a second PATCH
          // would only rewrite the same values.
          contentOutcome = { applied: null };
        } else if (createdId === undefined) {
          contentOutcome = {
            applied: false,
            error: 'the create response carried no id, so the content fields were not applied',
          };
        } else {
          const patch = await ctx.callRest(ctx.principal, {
            method: 'PATCH',
            url: `/v1/test-cases/${pathSegment(createdId)}`,
            body: content,
          });
          if (patch.statusCode < 400 && patch.json !== null && typeof patch.json === 'object') {
            contentOutcome = { applied: true };
            saved = shapeSavedTestCase(patch.json as Record<string, unknown>);
          } else {
            // Partial success, stated: the test case EXISTS; only its content did not land.
            contentOutcome = { applied: false, error: patch.json };
          }
        }
      }

      ctx.noteWrite?.({
        targets: typeof row['id'] === 'string' ? [row['id']] : [],
        fields: changed,
        count: 1,
      });
      return result(res.statusCode, res.json, {
        testCase: saved,
        changed,
        replayed,
        ...(contentOutcome !== undefined ? { content: contentOutcome } : {}),
      });
    },
  );
}

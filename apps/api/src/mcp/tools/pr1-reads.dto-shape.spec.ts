import { describe, expect, it } from 'vitest';
import {
  WorkflowStatusResponseSchema,
  WorkflowTransitionResponseSchema,
  LabelResponseSchema,
} from '@modules/projects/interface/http/dto/project-response.dto';
import { TestCaseTypeOptionSchema } from '@modules/test-cases/interface/http/dto/test-case-response.dto';
import { TestResultResponseSchema } from '@modules/test-cases/interface/http/dto/test-result-response.dto';
import { ActivityResponseSchema } from '@modules/activity/interface/http/dto/activity.dto';
import { buildVocabulary } from './project_vocabulary';
import { shapeTestResults } from './list_test_results';
import { shapeProjectActivity } from './project_activity';

/**
 * PR1's read tools, fed the PRODUCER's own shapes (parsed through their zod schemas), so a
 * renamed or removed DTO field breaks this test rather than reaching an agent as undefined.
 */
const PROJECT = { id: '0194a000-0000-7000-8000-000000000001', key: 'OBSE', name: 'Observability' };
const U = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('buildVocabulary (rova_project_vocabulary)', () => {
  it('maps the reference feeds and the transition endpoints', () => {
    const statuses = [
      WorkflowStatusResponseSchema.parse({
        id: U(2),
        projectId: PROJECT.id,
        name: 'In Progress',
        category: 'in_progress',
        color: null,
        position: 1,
        isDefault: false,
      }),
    ];
    const transitions = [
      WorkflowTransitionResponseSchema.parse({
        id: U(3),
        projectId: PROJECT.id,
        fromStatusId: U(2),
        toStatusId: U(4),
        name: 'Accept',
        requiredRole: null,
      }),
    ];
    const labels = [
      LabelResponseSchema.parse({
        id: U(5),
        projectId: PROJECT.id,
        name: 'customer-x',
        color: '#123456',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ];
    const testCaseTypes = [
      TestCaseTypeOptionSchema.parse({ id: U(6), name: 'Smoke', position: 1 }),
    ];

    const out = buildVocabulary(PROJECT, {
      statuses,
      transitions,
      labels,
      testCaseTypes,
      teams: [{ id: U(7), key: 'ALP', name: 'Alpha' }],
    });

    expect(out).toMatchObject({
      project: PROJECT,
      statuses: [{ id: U(2), name: 'In Progress', category: 'in_progress', isDefault: false }],
      transitions: [{ fromStatusId: U(2), toStatusId: U(4), name: 'Accept', requiredRole: null }],
      labels: [{ id: U(5), name: 'customer-x', color: '#123456' }],
      testCaseTypes: [{ id: U(6), name: 'Smoke', position: 1 }],
      teams: [{ id: U(7), key: 'ALP', name: 'Alpha' }],
    });
    expect(out['unavailable']).toBeUndefined();
  });

  it('marks an unreadable feed instead of failing the whole vocabulary', () => {
    const out = buildVocabulary(PROJECT, {
      statuses: [],
      transitions: [],
      labels: null,
      testCaseTypes: null,
      teams: [],
    });
    expect(out['labels']).toEqual([]);
    expect(out['unavailable']).toEqual(['labels', 'testCaseTypes']);
  });
});

describe('shapeTestResults (rova_list_test_results)', () => {
  it('maps the result fields, caps at limit and flags truncation', () => {
    const row = (n: number) =>
      TestResultResponseSchema.parse({
        id: U(10 + n),
        workspaceId: U(1),
        projectId: U(2),
        testCaseId: U(3),
        workItemId: null,
        workItemKey: null,
        testResultKey: `TR-${n}`,
        build: '1.4.2',
        runDate: '2026-06-20',
        verdict: 'pass',
        durationMinutes: 3,
        testerId: U(4),
        testerName: 'Linh',
        notes: null,
        createdBy: U(4),
        createdAt: '2026-06-20T08:00:00.000Z',
        updatedAt: '2026-06-20T08:00:00.000Z',
      });

    const out = shapeTestResults(
      { id: U(3), testCaseKey: 'TC-12', name: 'Login' },
      [row(1), row(2)],
      1,
    );
    expect((out['results'] as unknown[]).length).toBe(1);
    expect(out).toMatchObject({
      testCase: { testCaseKey: 'TC-12', name: 'Login' },
      results: [{ testResultKey: 'TR-1', build: '1.4.2', verdict: 'pass', testerName: 'Linh' }],
      truncated: true,
    });
  });
});

describe('shapeProjectActivity (rova_project_activity)', () => {
  it('maps the activity rows, filters by since and reports paging', () => {
    const rows = [
      ActivityResponseSchema.parse({
        id: U(20),
        createdAt: '2026-06-20T08:00:00.000Z',
        actorId: U(1),
        actorName: 'Ada',
        action: 'work_item.updated',
        entityType: 'work_item',
        entityId: U(21),
        changes: { field: 'title', old: 'a', new: 'b' },
        metadata: {},
      }),
      ActivityResponseSchema.parse({
        id: U(22),
        createdAt: '2026-06-18T08:00:00.000Z',
        actorId: U(1),
        actorName: 'Ada',
        action: 'work_item.created',
        entityType: 'work_item',
        entityId: U(21),
        changes: null,
        metadata: {},
      }),
    ];
    const out = shapeProjectActivity(
      PROJECT,
      { data: rows, total: 40, page: 1, pageSize: 2 },
      { since: '2026-06-19T00:00:00.000Z', page: 1, pageSize: 2 },
    );
    expect((out['activity'] as unknown[]).length).toBe(1);
    expect(out).toMatchObject({
      project: PROJECT,
      page: 1,
      pageSize: 2,
      total: 40,
      hasMore: true,
      since: '2026-06-19T00:00:00.000Z',
    });
  });
});

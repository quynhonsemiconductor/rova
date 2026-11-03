import { describe, expect, it } from 'vitest';
import { IterationReferenceSchema } from '@modules/iterations/interface/http/dto/iteration-response.dto';
import { ReleaseOptionSchema } from '@modules/releases/interface/http/dto/release-response.dto';
import { MemberOptionResponseSchema } from '@modules/workspace/interface/http/dto/workspace-response.dto';
import { WorkItemResponseSchema } from '@modules/work-items/interface/http/dto/work-item-response.dto';
import type { ToolContext } from './rest';
import { createRefResolver, personRef } from './refs';
import { resolveWorkItemRefs } from './get_work_item';
import { resolveToolWorkItemRefs, toToolWorkItem } from './search_work_items';

const PROJECT = '0194a000-0000-7000-8000-000000000003';
const ITERATION = '0194a000-0000-7000-8000-000000000007';
const RELEASE = '0194a000-0000-7000-8000-000000000008';
const TEAM = '0194a000-0000-7000-8000-000000000006';
const PERSON = '0194a000-0000-7000-8000-000000000005';
const PARENT = '0194a000-0000-7000-8000-00000000000a';

/**
 * A ToolContext whose REST bridge answers from a route table. The fixtures for each reference
 * feed go through the PRODUCER's own zod schema, so a renamed field breaks this test.
 */
function context(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const ctx: ToolContext = {
    principal: {
      userId: PERSON,
      workspaceId: '0194a000-0000-7000-8000-000000000002',
      sessionId: 'mcp:refs',
    },
    callRest: async (_principal, call) => {
      calls.push(call.url);
      if (!(call.url in routes)) return { statusCode: 404, json: { error: 'not found' } };
      return { statusCode: 200, json: routes[call.url] };
    },
  };
  return { ctx, calls };
}

const ITERATIONS = [
  IterationReferenceSchema.parse({
    id: ITERATION,
    name: 'Sprint 42',
    iterationKey: 'IT-42',
    state: 'planning',
    startDate: '2026-11-01',
    endDate: '2026-11-14',
    teamId: TEAM,
  }),
];

const RELEASES = [
  ReleaseOptionSchema.parse({
    id: RELEASE,
    projectId: PROJECT,
    releaseKey: 'RL-7',
    name: 'Autumn',
    status: 'planning',
    startDate: null,
    releaseDate: '2026-12-01',
  }),
];

const PEOPLE = [
  MemberOptionResponseSchema.parse({
    userId: PERSON,
    displayName: 'Ada Lovelace',
    email: 'ada@qnsc.vn',
    avatarUrl: null,
    assignable: true,
  }),
];

const TEAMS = [
  { id: TEAM, workspaceId: 'ws', name: 'Platform', key: 'PLT', leadId: PERSON, status: 'active' },
];

const PARENT_ITEM = WorkItemResponseSchema.parse({
  ...workItemFixture(),
  id: PARENT,
  itemKey: 'US-9',
  title: 'Parent story',
});

function workItemFixture() {
  return WorkItemResponseSchema.parse({
    id: '0194a000-0000-7000-8000-000000000001',
    workspaceId: '0194a000-0000-7000-8000-000000000002',
    projectId: PROJECT,
    itemKey: 'US-1',
    type: 'story',
    title: 'Upgrade NX workspace to v21',
    description: null,
    statusId: '0194a000-0000-7000-8000-000000000004',
    scheduleState: 'in_progress',
    flowState: 'in_progress',
    priority: 'high',
    assigneeId: PERSON,
    assigneeName: 'Ada',
    devOwnerName: 'Grace',
    reporterId: null,
    parentId: PARENT,
    teamId: TEAM,
    iterationId: ITERATION,
    releaseId: RELEASE,
    featureId: null,
    storyPoints: 5,
    estimateHours: 8,
    todoHours: 4,
    actualHours: null,
    acceptanceCriteria: 'it works',
    notes: null,
    releaseNotes: null,
    isBlocked: false,
    blockedReason: null,
    rank: '1000',
    customFields: {},
    createdBy: '0194a000-0000-7000-8000-000000000009',
    updatedBy: null,
    severity: null,
    foundInEnvironment: null,
    foundInReleaseId: null,
    rootCause: null,
    resolution: null,
    devOwnerId: null,
    defectState: null,
    fixedInBuild: null,
    startDate: null,
    targetEndDate: null,
    actualEndDate: null,
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  });
}

describe('createRefResolver', () => {
  it('resolves an iteration, a release, a team and a person from their own feeds', async () => {
    const { ctx } = context({
      '/v1/iterations/options': ITERATIONS,
      '/v1/releases/options': RELEASES,
      '/v1/workspaces/0194a000-0000-7000-8000-000000000002/teams': TEAMS,
      '/v1/workspaces/0194a000-0000-7000-8000-000000000002/member-options': PEOPLE,
    });
    const refs = createRefResolver(ctx);

    await expect(refs.iteration(ITERATION, PROJECT)).resolves.toEqual({
      id: ITERATION,
      name: 'Sprint 42',
      key: 'IT-42',
    });
    await expect(refs.release(RELEASE, PROJECT)).resolves.toEqual({
      id: RELEASE,
      name: 'Autumn',
      key: 'RL-7',
    });
    await expect(refs.team(TEAM)).resolves.toEqual({ id: TEAM, name: 'Platform', key: 'PLT' });
    await expect(refs.person(PERSON)).resolves.toEqual({ id: PERSON, name: 'Ada Lovelace' });
  });

  it('fetches each feed once, however many ids the page holds', async () => {
    const { ctx, calls } = context({
      '/v1/iterations/options': ITERATIONS,
      '/v1/workspaces/0194a000-0000-7000-8000-000000000002/member-options': PEOPLE,
    });
    const refs = createRefResolver(ctx);

    await Promise.all([
      refs.iteration(ITERATION, PROJECT),
      refs.iteration(ITERATION, PROJECT),
      refs.person(PERSON),
      refs.person(PERSON),
    ]);

    expect(calls.filter((url) => url === '/v1/iterations/options')).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith('/member-options'))).toHaveLength(1);
  });

  it('degrades an unreadable feed or an unknown id to the bare id, never a throw', async () => {
    const { ctx } = context({});
    const refs = createRefResolver(ctx);

    await expect(refs.iteration(ITERATION, PROJECT)).resolves.toEqual({
      id: ITERATION,
      name: null,
      key: null,
    });
    await expect(refs.person(PERSON)).resolves.toEqual({ id: PERSON, name: null });
    await expect(refs.team(TEAM)).resolves.toEqual({ id: TEAM, name: null, key: null });
  });

  it('returns null for a missing id and never calls REST', async () => {
    const { ctx, calls } = context({});
    const refs = createRefResolver(ctx);
    await expect(refs.iteration(null, PROJECT)).resolves.toBeNull();
    await expect(refs.person(undefined)).resolves.toBeNull();
    await expect(refs.parent('')).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('resolves a parent work item to its key and title', async () => {
    const { ctx } = context({ [`/v1/work-items/${PARENT}`]: PARENT_ITEM });
    await expect(createRefResolver(ctx).parent(PARENT)).resolves.toEqual({
      id: PARENT,
      itemKey: 'US-9',
      title: 'Parent story',
    });
  });

  it('prefers the DTO joined name over the picker feed', () => {
    expect(personRef(PERSON, 'Ada (DTO)', { id: PERSON, name: 'Ada Lovelace' })).toEqual({
      id: PERSON,
      name: 'Ada (DTO)',
    });
    expect(personRef(PERSON, null, { id: PERSON, name: 'Ada Lovelace' })).toEqual({
      id: PERSON,
      name: 'Ada Lovelace',
    });
  });
});

describe('work item tool shapes', () => {
  it('relays the detail row with refs instead of bare ids', async () => {
    const { ctx } = context({
      '/v1/iterations/options': ITERATIONS,
      '/v1/releases/options': RELEASES,
      '/v1/workspaces/0194a000-0000-7000-8000-000000000002/teams': TEAMS,
      '/v1/workspaces/0194a000-0000-7000-8000-000000000002/member-options': PEOPLE,
      [`/v1/work-items/${PARENT}`]: PARENT_ITEM,
    });
    const fixture = workItemFixture();
    const refs = await resolveWorkItemRefs(fixture, createRefResolver(ctx));

    expect(refs).toMatchObject({
      assignee: { id: PERSON, name: 'Ada' },
      devOwner: null,
      parent: { id: PARENT, itemKey: 'US-9', title: 'Parent story' },
      team: { id: TEAM, name: 'Platform', key: 'PLT' },
      iteration: { id: ITERATION, name: 'Sprint 42', key: 'IT-42' },
      release: { id: RELEASE, name: 'Autumn', key: 'RL-7' },
    });
  });

  it('relays the list row with the assignee and iteration named', async () => {
    const { ctx } = context({
      '/v1/iterations/options': ITERATIONS,
      '/v1/workspaces/0194a000-0000-7000-8000-000000000002/member-options': PEOPLE,
    });
    const fixture = workItemFixture();
    const refs = await resolveToolWorkItemRefs(fixture, createRefResolver(ctx));

    expect(toToolWorkItem(fixture, refs)).toMatchObject({
      id: fixture.id,
      assignee: { id: PERSON, name: 'Ada' },
      iteration: { id: ITERATION, name: 'Sprint 42', key: 'IT-42' },
    });
  });
});

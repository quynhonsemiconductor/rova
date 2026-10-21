/**
 * Blocked Reason lifecycle — real SQL.
 *
 * Rally: "When a blocked status is removed, the Blocked Reason field is cleared" (Broadcom
 * TechDocs, Task Board app). A reason that outlives its block asserts the item is blocked for
 * that reason while the flag next to it says otherwise — and the inline cell is only editable
 * WHILE blocked, so the stale text could be read and never removed.
 *
 * Real SQL rather than a service mock because what matters is the value the COLUMN ends up
 * holding: the rule lives in a spread over the update patch, and a mock proves only that the
 * patch was built, not that the row changed.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { workItems, workflowStatuses } from '@db/schema/work';

import { adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('blocked reason (e2e)', () => {
  let app: NestFastifyApplication;
  let items: WorkItemsService;
  let projects: ProjectsService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectId: string;
  let statusId: string;

  /** Straight from the column — not the service's return value. */
  async function stored(id: string) {
    const rows = await db
      .select({ isBlocked: workItems.isBlocked, blockedReason: workItems.blockedReason })
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);
    return rows[0];
  }

  async function newBlockedStory(reason = 'Waiting on the vendor') {
    const story = await items.createWorkItem(admin, projectId, 'story', `S ${uniqueKey()}`, {
      statusId,
    });
    await items.updateWorkItem(admin, story.id, { isBlocked: true, blockedReason: reason });
    return story.id;
  }

  beforeAll(async () => {
    app = await bootRovaApp();
    items = app.get(WorkItemsService);
    projects = app.get(ProjectsService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const project = await projects.createProject(admin, {
      key: uniqueKey(),
      name: 'Blocked Project',
    });
    projectId = project.id;
    const rows = await db
      .select({ id: workflowStatuses.id })
      .from(workflowStatuses)
      .where(eq(workflowStatuses.projectId, projectId))
      .limit(1);
    statusId = rows[0].id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('stores the reason while the item is blocked', async () => {
    const id = await newBlockedStory();
    expect(await stored(id)).toEqual({ isBlocked: true, blockedReason: 'Waiting on the vendor' });
  });

  it('CLEARS the reason when the item is unblocked', async () => {
    const id = await newBlockedStory();

    await items.updateWorkItem(admin, id, { isBlocked: false });

    expect(await stored(id)).toEqual({ isBlocked: false, blockedReason: null });
  });

  it('clears it even when the same patch also sends a reason', async () => {
    // The two cannot both be true, so `isBlocked: false` wins rather than the write order
    // deciding which survives.
    const id = await newBlockedStory();

    await items.updateWorkItem(admin, id, { isBlocked: false, blockedReason: 'Still stuck' });

    expect((await stored(id)).blockedReason).toBeNull();
  });

  it('lets a reason be edited while still blocked', async () => {
    const id = await newBlockedStory();

    await items.updateWorkItem(admin, id, { blockedReason: 'Now waiting on legal' });

    expect(await stored(id)).toEqual({ isBlocked: true, blockedReason: 'Now waiting on legal' });
  });

  it('leaves the reason alone on an unrelated edit', async () => {
    // A rename on a blocked item must not unblock anything by side effect.
    const id = await newBlockedStory();

    await items.updateWorkItem(admin, id, { title: `Renamed ${uniqueKey()}` });

    expect(await stored(id)).toEqual({ isBlocked: true, blockedReason: 'Waiting on the vendor' });
  });

  it('survives a block → unblock → block cycle without resurrecting the old reason', async () => {
    // The state that would betray a "hide it, do not clear it" implementation.
    const id = await newBlockedStory('First reason');
    await items.updateWorkItem(admin, id, { isBlocked: false });
    await items.updateWorkItem(admin, id, { isBlocked: true });

    expect(await stored(id)).toEqual({ isBlocked: true, blockedReason: null });
  });

  it('keeps the transition in the activity log, so nothing is actually lost', async () => {
    // Clearing the field is safe precisely because `activity-diff` tracks both `isBlocked` and
    // `blockedReason` — the text and the moment it went are recorded.
    const id = await newBlockedStory('Auditable reason');
    await items.updateWorkItem(admin, id, { isBlocked: false });

    // `changes` is ONE change per row, not a list — each field edit is its own entry.
    const activity = await items.getActivity(admin, id, { limit: 50, offset: 0 });
    const fields = activity.items.map((entry) => entry.changes?.field);
    expect(fields).toContain('blockedReason');
    expect(fields).toContain('isBlocked');
  });
});

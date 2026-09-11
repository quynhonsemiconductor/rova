/**
 * The reference data no seed reached: every table a page renders that was left EMPTY.
 *
 * Measured against a freshly seeded database, ten tables had zero rows — attachments and files, all
 * five notification tables, all six SCM tables behind the Connections tab, `audit_logs` and
 * `workflow_transitions`. A page whose data never exists in the fixture cannot be reviewed locally
 * and cannot be asserted end to end, so every test that needed one built it by hand.
 *
 * Also here: the two NXP timeboxes the reports need. The fixture had exactly one iteration, which
 * cannot express Velocity (needs a FINISHED iteration) or the backlog's unscheduled side (needs a
 * future one). One iteration is also why a team-scoped Velocity had nothing to draw.
 *
 * Test-only, like the rest of the fixture path. `pnpm db:seed` (the prod-safe baseline) never calls
 * this; `pnpm db:seed:test` does.
 */
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../schema';
import {
  attachments,
  iterationTeamBaselines,
  iterations,
  workItems,
  workflowStatuses,
  workflowTransitions,
} from '../schema/work';
import { files } from '../schema/storage';
import { inAppNotifications, notificationPreferences } from '../schema/notifications';
import {
  scmBackfillJobs,
  scmChangesets,
  scmConnections,
  scmInstallations,
  scmRepositories,
  scmWebhookInbox,
} from '../schema/scm';
import { auditLogs } from '../schema/audit';
import {
  ADMIN_USER_ID,
  DEVELOPER_ID,
  NXP_DEFECT_1_ID,
  NXP_FEATURE_1_ID,
  NXP_ITER_FUTURE_ID,
  NXP_ACCEPTED_STORY_ID,
  NXP_ITER_PAST_ID,
  NXP_STORY_1_ID,
  SEED_FILE_ID,
  SEED_PROJECTS,
  SEED_SCM_INSTALLATION_ID,
  SEED_SCM_REPOSITORY_ID,
  WORKSPACE_ID,
} from './constants';

type Db = NodePgDatabase<typeof schema>;

const NXP_ID = SEED_PROJECTS[0].id;

export async function seedReferenceExtras(db: Db): Promise<void> {
  await seedNxpTimeboxes(db);
  await seedAcceptedHistory(db);
  await seedFilesAndAttachments(db);
  await seedNotifications(db);
  await seedScm(db);
  await seedAuditAndTransitions(db);
}

/**
 * A FINISHED iteration and a FUTURE one, either side of the seeded active sprint.
 *
 * Velocity only plots timeboxes whose local end date has passed, so with one committed sprint the
 * chart was permanently empty. The future one gives the backlog something genuinely unscheduled to
 * show and `Add to iteration` somewhere to move work TO.
 *
 * Both are team-LESS on purpose: NXP's shared-sprint shape is what proved the reports must scope by
 * the work's team rather than the timebox's, and keeping it means that path stays covered.
 */
async function seedNxpTimeboxes(db: Db): Promise<void> {
  await db
    .insert(iterations)
    .values([
      {
        id: NXP_ITER_PAST_ID,
        workspaceId: WORKSPACE_ID,
        projectId: NXP_ID,
        iterationKey: 'IT-2',
        name: 'Sprint 25.12',
        goal: 'Close out the v1 tooling debt.',
        state: 'accepted',
        plannedVelocity: 18,
        // Ends before the seeded active sprint starts (2026-06-16), so the two never overlap.
        startDate: '2026-06-01',
        endDate: '2026-06-12',
      },
      {
        id: NXP_ITER_FUTURE_ID,
        workspaceId: WORKSPACE_ID,
        projectId: NXP_ID,
        iterationKey: 'IT-3',
        name: 'Sprint 26.2',
        goal: 'Ship the capacity planner polish.',
        state: 'planning',
        plannedVelocity: 21,
        startDate: '2026-06-29',
        endDate: '2026-07-10',
      },
    ])
    .onConflictDoNothing();

  /**
   * The finished sprint's Burndown baseline, in `iteration_team_baselines` (0098).
   *
   * `teamId: null` here is the table's "work with no resolvable team" row, which IS summed into All
   * Teams — not the measured-null of the snapshot tables. That is the truth for this fixture: both the
   * iteration and its accepted story are deliberately team-less, so `coalesce(task.team,
   * parent.team, iteration.team)` resolves to nothing and the whole 24 hours land in that row.
   */
  await db
    .insert(iterationTeamBaselines)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      iterationId: NXP_ITER_PAST_ID,
      teamId: null,
      totalTaskEstimateAtStart: '24',
      capturedAt: new Date('2026-06-01T08:00:00Z'),
    })
    .onConflictDoNothing();
}

/**
 * An ACCEPTED story inside the finished iteration.
 *
 * Two things need it. Velocity plots accepted points per completed timebox, so a past iteration with
 * no items draws an empty bar and proves nothing. And the Backlog has to show an iteration's NAME even
 * when that iteration is `accepted` — a rule that previously had no fixture, so a Playwright spec
 * created an iteration through the UI on every run to make one.
 *
 * `acceptedDate` is set explicitly INSIDE the window: the trigger stamps `now()`, which would classify
 * these points as accepted AFTER the sprint and move them to the wrong Velocity segment.
 */
async function seedAcceptedHistory(db: Db): Promise<void> {
  const statuses = await db
    .select({ id: workflowStatuses.id, category: workflowStatuses.category })
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, NXP_ID));
  const done = statuses.find((row) => row.category === 'done')?.id;
  if (!done) return;

  await db
    .insert(workItems)
    .values({
      id: NXP_ACCEPTED_STORY_ID,
      workspaceId: WORKSPACE_ID,
      projectId: NXP_ID,
      // Team-less like its iteration, so the reports' `coalesce(item.team, iteration.team)` fallback
      // has a row that exercises the null-null case.
      iterationId: NXP_ITER_PAST_ID,
      itemKey: 'US-3',
      type: 'story',
      title: 'Retire the legacy eslint config',
      description: 'Delete .eslintrc and move every package onto the flat config.',
      statusId: done,
      scheduleState: 'accepted',
      flowState: 'accepted',
      priority: 'normal',
      storyPoints: '8',
      acceptedDate: new Date('2026-06-11T14:00:00Z'),
      assigneeId: DEVELOPER_ID,
      reporterId: ADMIN_USER_ID,
      createdBy: ADMIN_USER_ID,
      rank: 'i00010:',
    })
    .onConflictDoNothing();

  await db
    .update(schema.workspaceItemCounters)
    .set({ lastItemNumber: sql`GREATEST(${schema.workspaceItemCounters.lastItemNumber}, 3)` })
    .where(
      and(
        eq(schema.workspaceItemCounters.workspaceId, WORKSPACE_ID),
        eq(schema.workspaceItemCounters.itemType, 'story'),
      ),
    );
}

/**
 * One uploaded FILE and the attachment rows that point at it.
 *
 * `attachments` is polymorphic since migration 0083, so both an entity types get a row — a work item
 * and a portfolio item — which is the pair that proves one uploader serves both surfaces.
 */
async function seedFilesAndAttachments(db: Db): Promise<void> {
  await db
    .insert(files)
    .values({
      id: SEED_FILE_ID,
      workspaceId: WORKSPACE_ID,
      // A key, not a URL: the bucket is resolved at read time, so a seeded absolute URL would rot
      // the moment the endpoint changes.
      storageKey: `workspaces/${WORKSPACE_ID}/seed/architecture-notes.pdf`,
      filename: 'architecture-notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 148_223,
      visibility: 'private',
      // `completed`, because a `pending` row is a half-finished upload and renders as one.
      status: 'completed',
      uploadedBy: ADMIN_USER_ID,
    })
    .onConflictDoNothing();

  await db
    .insert(attachments)
    .values([
      {
        entityType: 'work_item',
        entityId: NXP_STORY_1_ID,
        fileId: SEED_FILE_ID,
        workspaceId: WORKSPACE_ID,
        attachedBy: ADMIN_USER_ID,
      },
      {
        entityType: 'portfolio_item',
        entityId: NXP_FEATURE_1_ID,
        fileId: SEED_FILE_ID,
        workspaceId: WORKSPACE_ID,
        attachedBy: ADMIN_USER_ID,
      },
    ])
    .onConflictDoNothing();
}

/**
 * In-app notifications plus the PREFERENCES that decide whether email follows.
 *
 * One read and one unread, because the bell's badge counts unread and "all read" is a different
 * screen from "nothing has happened". Preferences are seeded for both users so the relay's
 * email-cascade branch has a real row to read rather than falling back to a default.
 *
 * `metadata.projectId` is REQUIRED on a work-item row, not decoration. Every recipient-scoped read
 * filters on `metadata->>'projectId'` (SRS §7 :199-200) and a notification naming NO project is
 * deliberately always visible — that branch exists for `WORKSPACE_INVITATION`. These two rows had
 * only `itemKey`, so they landed in the always-visible branch and anything leaning on them exercised
 * the BYPASS instead of the filter. Every work-item template threads the project
 * (`notification.templates.ts` :102-129), so a fixture without it is not what production writes.
 */
async function seedNotifications(db: Db): Promise<void> {
  await db
    .insert(inAppNotifications)
    .values([
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        recipientId: ADMIN_USER_ID,
        actorId: DEVELOPER_ID,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'US-1 assigned to you',
        body: 'Migrate the workspace to NX v21',
        resourceType: 'work_item',
        resourceId: NXP_STORY_1_ID,
        metadata: { itemKey: 'US-1', projectId: NXP_ID },
        isRead: false,
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        recipientId: DEVELOPER_ID,
        actorId: ADMIN_USER_ID,
        type: 'WORK_ITEM_COMMENTED',
        title: 'New comment on DE-1',
        body: 'Windows CI checkout is flaky again',
        resourceType: 'work_item',
        resourceId: NXP_DEFECT_1_ID,
        metadata: { itemKey: 'DE-1', projectId: NXP_ID },
        isRead: true,
        readAt: new Date('2026-06-26T09:15:00Z'),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(notificationPreferences)
    .values(
      [ADMIN_USER_ID, DEVELOPER_ID].flatMap((userId) =>
        ['WORK_ITEM_ASSIGNED', 'WORK_ITEM_COMMENTED', 'WORK_ITEM_MENTIONED'].map((type) => ({
          id: uuidv7(),
          workspaceId: WORKSPACE_ID,
          userId,
          type,
          inApp: true,
          // Email ON for the admin, OFF for the developer: the relay's cascade has to be observable
          // in both directions, and a fixture where everyone agrees proves only one branch.
          email: userId === ADMIN_USER_ID,
          updatedAt: new Date(),
        })),
      ),
    )
    .onConflictDoNothing();
}

/**
 * The whole SCM chain behind the Connections tab: installation → repository → connection/changeset.
 *
 * Six tables, all empty before this, so the tab had nothing to render and the webhook path had no
 * fixture at all. `webhook_inbox` and `backfill_jobs` are seeded in their DONE states — a pending
 * row would be picked up by the running worker and processed, which makes a fixture that changes
 * under the test.
 */
async function seedScm(db: Db): Promise<void> {
  await db
    .insert(scmInstallations)
    .values({
      id: SEED_SCM_INSTALLATION_ID,
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      installationId: '90000001',
      accountLogin: 'quynhonsemiconductor',
      active: true,
    })
    .onConflictDoNothing();

  await db
    .insert(scmRepositories)
    .values({
      id: SEED_SCM_REPOSITORY_ID,
      workspaceId: WORKSPACE_ID,
      installationId: SEED_SCM_INSTALLATION_ID,
      provider: 'github',
      fullName: 'quynhonsemiconductor/rova',
      active: true,
    })
    .onConflictDoNothing();

  // A PR on the story and a branch on the defect — the two connection types a reader actually sees.
  await db
    .insert(scmConnections)
    .values([
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        workItemId: NXP_STORY_1_ID,
        provider: 'github',
        type: 'pull_request',
        externalId: '4821',
        name: 'feat(nx): upgrade to v21',
        url: 'https://github.com/quynhonsemiconductor/rova/pull/4821',
        state: 'open',
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        workItemId: NXP_DEFECT_1_ID,
        provider: 'github',
        type: 'branch',
        externalId: 'fix/windows-ci-checkout',
        name: 'fix/windows-ci-checkout',
        url: 'https://github.com/quynhonsemiconductor/rova/tree/fix/windows-ci-checkout',
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(scmChangesets)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      workItemId: NXP_STORY_1_ID,
      provider: 'github',
      revision: '9f2c1ab',
      name: 'feat(nx): bump workspace to v21',
      uri: 'https://github.com/quynhonsemiconductor/rova/commit/9f2c1ab',
      repositoryFullName: 'quynhonsemiconductor/rova',
      authorName: 'Nghia-VanTrong',
      committedAt: new Date('2026-06-24T11:02:00Z'),
      changes: [
        { action: 'M', path: 'workspace.json' },
        { action: 'A', path: 'tools/migrate-nx21.ts' },
      ],
    })
    .onConflictDoNothing();

  await db
    .insert(scmWebhookInbox)
    .values({
      id: uuidv7(),
      provider: 'github',
      deliveryId: 'seed-delivery-0001',
      eventType: 'pull_request',
      payload: { action: 'opened', number: 4821 },
      // `processed`, not `pending`: a pending row is WORK, and the running worker would claim it —
      // a fixture that changes under the test is worse than no fixture.
      status: 'processed',
      attempts: 1,
      scheduledAt: new Date('2026-06-24T11:00:00Z'),
      receivedAt: new Date('2026-06-24T11:00:00Z'),
      processedAt: new Date('2026-06-24T11:00:02Z'),
    })
    .onConflictDoNothing();

  await db
    .insert(scmBackfillJobs)
    .values({
      id: uuidv7(),
      workspaceId: WORKSPACE_ID,
      repositoryId: SEED_SCM_REPOSITORY_ID,
      status: 'done',
      attempts: 1,
      scheduledAt: new Date('2026-06-24T10:00:00Z'),
      requestedAt: new Date('2026-06-24T10:00:00Z'),
      finishedAt: new Date('2026-06-24T10:04:00Z'),
    })
    .onConflictDoNothing();
}

/**
 * Audit rows, and the workflow TRANSITIONS a project's board is meant to constrain.
 *
 * `audit_logs` is the governance surface; empty, it renders as "nothing has ever happened" in a
 * workspace that demonstrably has. Transitions were empty too, which means the workflow allowed
 * every jump — the seeded set is the linear one the default statuses imply, plus the reopen edge.
 */
async function seedAuditAndTransitions(db: Db): Promise<void> {
  await db
    .insert(auditLogs)
    .values([
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        actorId: ADMIN_USER_ID,
        action: 'project.created',
        resourceType: 'project',
        resourceId: NXP_ID,
        metadata: { key: 'NXP' },
        occurredAt: new Date('2026-06-01T09:00:00Z'),
      },
      {
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        actorId: ADMIN_USER_ID,
        action: 'workspace.member.added',
        resourceType: 'user',
        resourceId: DEVELOPER_ID,
        metadata: { role: 'project_member' },
        occurredAt: new Date('2026-06-01T09:05:00Z'),
      },
    ])
    .onConflictDoNothing();

  const statuses = await db
    .select({ id: workflowStatuses.id, position: workflowStatuses.position })
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, NXP_ID))
    // `position`, and `id` to break a tie — two statuses may share a position, and the transition
    // graph has to be the same on every seed run.
    .orderBy(workflowStatuses.position, workflowStatuses.id);
  if (statuses.length < 2) return;

  const edges = statuses.slice(0, -1).map((from, at) => ({
    id: uuidv7(),
    workspaceId: WORKSPACE_ID,
    projectId: NXP_ID,
    fromStatusId: from.id,
    toStatusId: statuses[at + 1].id,
    name: 'Advance',
  }));
  // The reopen edge: last → first. Without it the board is one-way, which no team works like.
  edges.push({
    id: uuidv7(),
    workspaceId: WORKSPACE_ID,
    projectId: NXP_ID,
    fromStatusId: statuses[statuses.length - 1].id,
    toStatusId: statuses[0].id,
    name: 'Reopen',
  });
  await db.insert(workflowTransitions).values(edges).onConflictDoNothing();

  // Keep the iteration counter ahead of the two timeboxes seeded above, so the app cannot mint a
  // key one of them already holds.
  await db
    .update(schema.workspaceItemCounters)
    .set({ lastItemNumber: sql`GREATEST(${schema.workspaceItemCounters.lastItemNumber}, 3)` })
    .where(
      and(
        eq(schema.workspaceItemCounters.workspaceId, WORKSPACE_ID),
        eq(schema.workspaceItemCounters.itemType, 'task'),
      ),
    );
}

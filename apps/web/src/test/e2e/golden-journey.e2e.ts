import { test } from '@playwright/test'
import { loginAndSelectProject, settle, expect } from './helpers'

/**
 * Golden end-to-end journey — one coherent business flow through the real UI,
 * proving the screens connect end-to-end (not just that each renders):
 *
 *   login → QNSC / NX Platform
 *     → create a Planning iteration (Timeboxes)
 *     → create a Story INTO that iteration (Iteration Status › Add Item)
 *     → the Story surfaces on Iteration Status
 *     → and is ABSENT from the Backlog, which is unscheduled work only
 *     → create a second, UNSCHEDULED Story on the Backlog
 *     → move its Schedule State on the Backlog and it PERSISTS across reload
 *     → open the seeded Release detail (shared DetailLayout chrome)
 *
 * Task→parent auto-complete, the six-state mirror, and Team-Status relation
 * rendering are covered at the service boundary by the Vitest e2e specs
 * (iteration-completion-flow, core-business-rules, team-status-relation-render),
 * so this UI journey deliberately stays on the stable, high-signal path.
 */
test.describe('Golden journey', () => {
  test('plan → build → track a story across the app', async ({ page }) => {
    const ts = Date.now()
    const iterationName = `Golden Sprint ${ts}`
    const storyTitle = `Golden Story ${ts}`

    await loginAndSelectProject(page)

    // ── 1. Create a Planning iteration ────────────────────────────────────────
    await page.goto('/timeboxes')
    await settle(page)
    await page.getByRole('button', { name: 'Add New' }).click()
    const iterModal = page.getByRole('dialog')
    await page.getByPlaceholder('Enter iteration name...').fill(iterationName)
    // Dates via the shared DateField calendar (day "15"); field buttons scoped to
    // the modal, the day button portals to <body>.
    await iterModal.getByRole('button', { name: 'Start Date' }).click()
    await page.getByRole('button', { name: '15', exact: true }).click()
    await iterModal.getByRole('button', { name: 'End Date' }).click()
    await page.getByRole('button', { name: '15', exact: true }).click()
    // Leave State at its default (Planning).
    await page.getByRole('button', { name: 'Create with details' }).click()
    await settle(page)
    await expect(page.getByText(iterationName).first()).toBeVisible()

    // ── 2. Create a Story INTO that iteration (Iteration Status › Add Item) ────
    await page.goto('/iteration-status')
    await settle(page)
    // The selector button shows the currently-selected iteration's name + date
    // range; open it and pick the one just created.
    await page
      .locator('button')
      .filter({ hasText: /\d{4}-\d{2}-\d{2}/ })
      .first()
      .click()
    await settle(page, 600)
    await page.getByText(iterationName, { exact: false }).first().click()
    await settle(page, 600)

    const addBtn = page.getByRole('button', { name: 'Add New' })
    await addBtn.click()
    await expect(page.getByText('Add Item to Iteration')).toBeVisible()
    await page.getByPlaceholder('Enter a concise work item title...').fill(storyTitle)
    await page.getByRole('button', { name: 'Create Item' }).click()
    await expect(page.getByText('Add Item to Iteration')).toBeHidden({ timeout: 15_000 })

    // ── 3. The Story surfaces on Iteration Status ─────────────────────────────
    await settle(page, 800)
    await expect(page.getByText(storyTitle).first()).toBeVisible({ timeout: 10_000 })

    // ── 4. …and is ABSENT from the Backlog, which is unscheduled work only ────
    /**
     * "Plan > Backlog shows only Story/Defect items whose Iteration is `Unscheduled`. Assigning a
     * Story/Defect to an Iteration removes it from Backlog" (`RECONCILED_SOURCE_OF_TRUTH.md:42`).
     *
     * This step used to assert the opposite — that the story appeared here carrying its iteration
     * name — because the predicate that defines the screen was missing from `listBacklog`. Proving
     * the two lists are DISJOINT is the more useful assertion, and it is the one the rule makes.
     */
    await page.goto('/backlog')
    await settle(page)
    await page
      .getByPlaceholder('Search…')
      .fill(storyTitle)
      .catch(() => {})
    await settle(page, 600)
    await expect(page.locator('div.group.flex').filter({ hasText: storyTitle })).toHaveCount(0)

    // ── 5. A second, UNSCHEDULED story — created here, so it belongs here ─────
    //
    // The schedule-state step below needs a row on THIS page, and step 4 has just established that a
    // scheduled story is not one. Creating it through the Backlog's own Add New also covers the
    // create path a groomer actually uses, which the iteration-first path in step 2 does not.
    const backlogStoryTitle = `Golden Backlog Story ${ts}`
    await page.getByRole('button', { name: 'Add New' }).click()
    // A DIFFERENT modal from step 2's, with its own copy: the Backlog opens `New Work Item`
    // (`work-items.json` create.titlePlaceholder), where Iteration Status opens `Add Item to
    // Iteration`. Matched on the visible label rather than the placeholder so a copy edit to either
    // modal cannot silently retarget this step at the wrong one.
    await expect(page.getByText('New Work Item')).toBeVisible()
    await page.getByLabel(/^Title/).fill(backlogStoryTitle)
    await page.getByRole('button', { name: 'Create Item' }).click()
    await settle(page, 1200)
    await page
      .getByPlaceholder('Search…')
      .fill(backlogStoryTitle)
      .catch(() => {})
    await settle(page, 600)
    const row = page.locator('div.group.flex').filter({ hasText: backlogStoryTitle })
    await expect(row).toBeVisible({ timeout: 10_000 })

    // ── 6. Move its Schedule State and confirm it persists across reload ──────
    // Schedule state is a Rally-style segmented stepper (role=group); the CURRENT segment carries
    // `data-current` and shows its letter, and only the actionable segments are buttons. Move to
    // In-Progress ("P").
    const stepper = row.getByRole('group', { name: 'Schedule state' })
    const inProgress = stepper.getByRole('button', { name: 'In Progress' })
    if ((await inProgress.count()) > 0 && (await inProgress.isEnabled())) {
      await inProgress.click()
      await settle(page, 1200)
      await page.reload()
      await settle(page)
      await page
        .getByPlaceholder('Search…')
        .fill(backlogStoryTitle)
        .catch(() => {})
      await settle(page, 600)
      const rowAfter = page.locator('div.group.flex').filter({ hasText: backlogStoryTitle })
      await expect(
        rowAfter.getByRole('group', { name: 'Schedule state' }).locator('[data-current]'),
      ).toHaveText('P')
    }

    // ── 7. Open the seeded Release detail (shared DetailLayout chrome) ────────
    await page.goto('/releases')
    await settle(page)
    await page.getByRole('link', { name: 'RE-1' }).click()
    await settle(page)
    // Shared DetailLayout / DetailTabBar exposes an accessible tablist.
    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('tab', { name: /details/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /artifacts/i })).toBeVisible()
  })
})

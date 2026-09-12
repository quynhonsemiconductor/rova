import { test } from '@playwright/test'

import { expect, loginAndSelectProject, settle } from './helpers'

/**
 * Iteration Status, as ONE journey: the page renders its strip and grid, then a row is blocked, given
 * a reason, and unblocked again.
 *
 * Merged with `blocked-reason-inline-edit`, which paid its own login to reach this same page. The
 * blocked-reason flow implies the page rendered, so asserting both in sequence costs one navigation
 * instead of two and reads as something a user actually does.
 *
 * The milestone cell's shared multi-select — also on this page — lives in `releases-milestones.e2e.ts`
 * with the rest of that surface. Creating a Story into the selected iteration is the golden journey's
 * job, which also proves it reaches the Backlog.
 */

/**
 * Scroll the grid to its right edge.
 *
 * Blocked and Blocked Reason are the last columns, and Playwright's auto-scroll acts on the ELEMENT it
 * is about to touch — which does nothing while the cell sits outside a horizontally scrolling
 * container. Found by geometry rather than a test id: the container is whichever div actually
 * overflows, so a layout change cannot silently point this at the wrong node.
 */
async function scrollGridRight(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollWidth > d.clientWidth + 50 && getComputedStyle(d).overflowX !== 'visible',
    )
    if (el) el.scrollLeft = el.scrollWidth
  })
  await page.waitForTimeout(400)
}

test.describe('Iteration Status', () => {
  test('renders the metric strip, then blocks a row, gives a reason, and unblocks it', async ({
    page,
  }) => {
    await loginAndSelectProject(page)
    await page.goto('/iteration-status', { waitUntil: 'domcontentloaded' })
    await settle(page)

    // ── The strip ───────────────────────────────────────────────────────────
    // Metrics come from the read-model and land after the iteration list resolves, so the first label
    // gets a generous wait and the rest are then present synchronously. `.first()` because some labels
    // also appear as column headers. Text is upper-cased in CSS, so the DOM stays mixed-case.
    await expect(page.getByText('Planned Velocity').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Iteration End').first()).toBeVisible()
    await expect(page.getByText('Defects').first()).toBeVisible()
    await expect(page.getByText('Tasks').first()).toBeVisible()

    // ── Blocked + reason: the inline-edit gating rule ────────────────────────
    await scrollGridRight(page)

    // Start from a known-unblocked state. Unblocking clears the reason server-side, so this loop also
    // removes whatever a previous run left behind — no separate cleanup step.
    for (const unblock of await page.getByTitle('Blocked - Click to Unblock').all()) {
      await unblock.click().catch(() => {})
      await page.waitForTimeout(200)
    }

    await page.getByTitle('Unblocked - Click to Block').first().click()
    await page.waitForTimeout(500)

    // The reason is editable only once the row is BLOCKED — that gating is the rule under test.
    const addReason = page.getByText('Add reason…').first()
    await expect(addReason).toBeVisible()
    await addReason.click()
    const input = page.getByRole('textbox', { name: 'Blocked reason' })
    await expect(input).toBeVisible()
    await input.fill('Waiting on infra provisioning')
    await input.press('Enter')
    await expect(page.getByText('Waiting on infra provisioning')).toBeVisible()

    // Unblocking CLEARS the reason — the behaviour, and the fixture restore, in one step.
    await page.getByTitle('Blocked - Click to Unblock').first().click()
    await expect(page.getByTitle('Unblocked - Click to Block').first()).toBeVisible()
    await expect(page.getByText('Waiting on infra provisioning')).toHaveCount(0)

    // Still gone after a reload: the server cleared the column, the client did not merely hide it.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page)
    await scrollGridRight(page)
    await expect(page.getByText('Waiting on infra provisioning')).toHaveCount(0)
  })
})

/**
 * The two Production reports of 2026-08-21, walked in the browser.
 *
 * Both were invisible to a unit test for the same reason: each was a mismatch between what the page
 * ASKED the server and what the server was willing to answer, so only a real request shows it.
 */
test.describe('Iteration Status — the BA repro paths', () => {
  test('the Owner dropdown offers the Team, not just the placeholder', async ({ page }) => {
    /**
     * The dropdowns showed nothing but `No Entry` and no active Team member could be assigned. The
     * page fetched the project-wide candidate feed (no team), which is the assignment rule's no-Team
     * branch — project Admins, deliberately no Editors — so on a project staffed by Editors it is
     * empty. The row now asks with its OWN team.
     *
     * Asserted as "more than the placeholder" rather than as a named person: the seeded roster is a
     * fixture fact, while "the picker offers somebody eligible" is the rule. Owner is a late column,
     * so the grid has to be scrolled before the cell can be clicked at all.
     */
    await loginAndSelectProject(page)
    await page.goto('/iteration-status')
    await settle(page)
    await scrollGridRight(page)

    // `getByLabel`, not `getByRole('button', { name: 'Owner' })`: the sort HEADER is a button with
    // that text too, and clicking it sorts the grid instead of opening a picker.
    await page.getByLabel('Owner', { exact: true }).first().click()
    await settle(page, 600)

    // The popover is identified by its own search box — the one node unique to it. EXACT, because
    // `getByPlaceholder` matches substrings and the toolbar's `Search iterations…` contains it.
    const search = page.getByPlaceholder('Search', { exact: true })
    await expect(search).toBeVisible()
    // Radix portals the content and wraps it in `[data-radix-popper-content-wrapper]`. Scoping to
    // that, not to "a div containing the search box" — the innermost such div IS the search box, and
    // it holds no options.
    const popover = page.locator('[data-radix-popper-content-wrapper]').filter({ has: search })

    // Options are plain buttons here, not `role="option"`. `Unassigned` is always one of them; the
    // defect was that it was the ONLY one.
    const options = popover.getByRole('button')
    expect(
      await options.count(),
      'the Owner feed offered nothing but the placeholder',
    ).toBeGreaterThan(1)
  })

  test('the chevrons are inverses, and stop at the right ends', async ({ page }) => {
    /**
     * From KB Sprint 1 the LEFT chevron advanced to KB Sprint 2: the feed is newest-first and the
     * handlers were `index - 1` / `index + 1`, so both arrows ran backwards in time.
     *
     * The CHRONOLOGY is pinned as a unit (`stepIndexInTime` in `shared/lib/step-in-time.test.ts`),
     * where a newest-first list can be stated exactly. What only a browser can show is that the two
     * controls are WIRED to it: stepping earlier and then later must land back on the same
     * iteration, and the end each one stops at must be the end its icon implies. The identity is the
     * selector's own label, which carries the name and the window.
     */
    await loginAndSelectProject(page)
    await page.goto('/iteration-status')
    await settle(page)

    const earlier = page.getByRole('button', { name: 'Previous iteration' })
    const later = page.getByRole('button', { name: 'Next iteration' })
    await expect(earlier).toBeVisible()
    await expect(later).toBeVisible()

    if (await earlier.isDisabled()) {
      // Already at the earliest, so there is nothing to step to. Then `later` must be the enabled
      // one — a state where BOTH are disabled would mean a single iteration, and where both are
      // enabled at an end would be the reversed-direction defect itself.
      await expect(later).toBeEnabled()
      return
    }

    const selector = page.locator('button', { hasText: /\d{4}|\w{3} \d{1,2}/ }).first()
    const before = (await selector.innerText()).trim()

    await earlier.click()
    await settle(page)
    const afterEarlier = (await selector.innerText()).trim()
    expect(afterEarlier, 'stepping earlier must change the iteration').not.toBe(before)

    // …and back. If the arrows were reversed relative to each other this would not return.
    await later.click()
    await settle(page)
    expect((await selector.innerText()).trim(), 'the arrows must be inverses').toBe(before)

    // Walk to the earliest end: `Previous iteration` must be what disables there, never `Next`.
    for (let i = 0; i < 20 && !(await earlier.isDisabled()); i++) {
      await earlier.click()
      await settle(page, 400)
    }
    await expect(earlier).toBeDisabled()
    await expect(later, 'at the earliest iteration, Next must still be available').toBeEnabled()
  })
})

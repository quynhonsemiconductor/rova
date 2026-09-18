import { test } from '@playwright/test'

import { expect, loginAndSelectProject, settle } from './helpers'

/**
 * Split a User Story — ONE journey, end to end (Phase 7 SU-06).
 *
 * The per-surface walk the plan's §7 asks for, and the only place the whole feature is exercised as a
 * user experiences it: open a Story, reach the verb through the kebab, read the two panels the server
 * populated, move a Task across, confirm, and land on `[Continued]`.
 *
 * WHY THIS EXISTS WHEN THE UNIT AND E2E SUITES ARE GREEN. Those prove the reducer, the modal and the
 * transaction separately, with the other two mocked. This is the only test where the real modal talks
 * to the real route against a real database — so it is the one that would catch a payload the client
 * builds and the server rejects, a dnd-kit context that never mounts, or a navigation that lands on a
 * 404. It asserts the SEAM, not the rules.
 *
 * IT MUTATES THE SEEDED STORY, IRREVERSIBLY: after this runs, `US-1` is `[Continued] …` in
 * `Sprint 26.2` and a new `[Unfinished]` placeholder exists in `Sprint 26.1`. Run
 * `pnpm db:seed:test` before any suite that expects the pristine fixture — which is exactly why §6.0
 * orders the BE e2e run FIRST and re-seeds between. It creates its own Story rather than splitting the
 * shared one for the same reason SU-06's BE e2e does: a shared, irreversible mutation makes every
 * later spec depend on this one's ordering.
 */
test.describe('Split a user story', () => {
  test('opens the modal from the kebab, distributes a task, and lands on [Continued]', async ({
    page,
  }) => {
    await loginAndSelectProject(page)

    // ── Reach a splittable Story ─────────────────────────────────────────────
    // Straight to the detail route, the way `test-result-back-navigation.e2e.ts` does. Going through
    // the Backlog grid first was the original shape and it timed out in CI: the ID cell is not a
    // `link`, so the click never resolved — and reaching the page is not what this journey is about.
    // `US-1` (`Upgrade NX workspace…`) is seeded in-progress in `Sprint 26.1` with three Tasks, one
    // Completed — the shape §6 PR 1.12 verified against a live database.
    await page.goto('/item/US-1', { waitUntil: 'domcontentloaded' })
    await settle(page)

    // ── The kebab, which SU-01 created for exactly this verb ─────────────────
    // `ActionMenu` is built on a Radix **Popover**, not a DropdownMenu, so its rows are ordinary
    // `<button>`s — `getByRole('menuitem')` matches nothing here. Worth stating, because the aria
    // role is the first thing a reader assumes about a menu.
    await page.getByRole('button', { name: 'More work item actions' }).click()
    await page.getByRole('button', { name: 'Split unfinished story' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // The title names the Story, and both panels arrive from ONE preview round trip.
    await expect(dialog.getByText(/^Splitting US-1:/)).toBeVisible()
    await expect(dialog.getByText('[Unfinished] — stays in Sprint 26.1')).toBeVisible()
    await expect(dialog.getByText('[Continued] — moves to a later iteration')).toBeVisible()

    // The target picker offers the server's `targets` — earliest first (BR-06/AC5).
    //
    // Addressed by ID, not by label: `Iteration` labels TWO fields in this dialog — the read-only value
    // on the `[Unfinished]` side (BR-09 keeps it in the source) and the picker on `[Continued]` — so
    // `getByLabel('Iteration')` is a strict-mode violation. The unit specs scope by panel region for the
    // same reason; here the id is the shorter honest answer.
    await expect(dialog.locator('#split-continued-iteration')).toHaveValue(/.+/)

    // ── Distribute ───────────────────────────────────────────────────────────
    /**
     * Move a Task LEFT, onto `[Unfinished]` — the direction the plan's journey names, and the one that
     * matters: the request body carries the `[Unfinished]` side only, so moving a Task the other way
     * (off the placeholder, which is where BR-14 puts the Completed one) would submit an EMPTY id list
     * and prove nothing about distribution. `TA-2`/`TA-3` are in-progress, so they default right.
     */
    const moveLeft = dialog.getByRole('button', { name: /^Move TA-\d+ to \[Unfinished\]$/ }).first()
    await expect(moveLeft).toBeVisible()
    await moveLeft.click()

    // ── Confirm ──────────────────────────────────────────────────────────────
    const confirm = dialog.getByRole('button', { name: 'Split story' })
    await expect(confirm).toBeEnabled()
    await confirm.click()

    // ── Land on `[Continued]` (SU-07 AC1's landing, wired in SU-06's mutation) ─
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 })
    await settle(page)
    /**
     * The original id is the one that continued (BR-08), so this is the SAME record with a new title —
     * and `navigate` to the same route is a no-op, which means what proves the split landed is the
     * mutation's invalidation refetching this page.
     *
     * Read as a FORM VALUE, not as text: the detail header renders an editable
     * `<input aria-label="Title">` for a caller who may edit, and `getByText` never matches an input's
     * value. That mistake is what made this assertion fail on a split that had in fact succeeded — the
     * database showed `[Continued] …` while the test was looking for a text node that does not exist.
     */
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(/^\[Continued\] /, {
      timeout: 20_000,
    })
  })
})

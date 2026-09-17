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
    // The Backlog is where a Story is reached by name; `US-1` (`Upgrade NX workspace…`) is seeded
    // in-progress in `Sprint 26.1` with three Tasks, one Completed — the shape §6 PR 1.12 verified
    // against a live database.
    await page.goto('/backlog', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.getByRole('link', { name: 'US-1' }).first().click()
    await settle(page)

    // ── The kebab, which SU-01 created for exactly this verb ─────────────────
    await page.getByRole('button', { name: 'More work item actions' }).click()
    await page.getByRole('menuitem', { name: 'Split unfinished story' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // The title names the Story, and both panels arrive from ONE preview round trip.
    await expect(dialog.getByText(/^Splitting US-1:/)).toBeVisible()
    await expect(dialog.getByText('[Unfinished] — stays in Sprint 26.1')).toBeVisible()
    await expect(dialog.getByText('[Continued] — moves to a later iteration')).toBeVisible()

    // The target picker offers the server's `targets` — earliest first (BR-06/AC5).
    await expect(dialog.getByLabel('Iteration')).toHaveValue(/.+/)

    // ── Distribute ───────────────────────────────────────────────────────────
    // BR-14: the Completed Task (`TA-1`) starts on the `[Unfinished]` side. Moving a Task the other way
    // is the interaction SU-03 built, and the arrow is the accessible path to it.
    const moveRight = dialog.getByRole('button', { name: /^Move TA-\d+ to \[Continued\]$/ }).first()
    await expect(moveRight).toBeVisible()
    await moveRight.click()

    // ── Confirm ──────────────────────────────────────────────────────────────
    const confirm = dialog.getByRole('button', { name: 'Split story' })
    await expect(confirm).toBeEnabled()
    await confirm.click()

    // ── Land on `[Continued]` (SU-07 AC1's landing, wired in SU-06's mutation) ─
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 })
    await settle(page)
    // The original id is the one that continued (BR-08), so the detail page is the same record with a
    // new title — and it is now in the target Iteration (BR-11).
    await expect(page.getByText(/\[Continued\]/).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Sprint 26.2').first()).toBeVisible()
  })
})

import { test } from '@playwright/test'

import { expect, loginAndSelectProject, settle } from './helpers'

/**
 * Reports and Release Tracking, as two journeys — the Phase 6 surfaces that had NO browser coverage
 * at all.
 *
 * Everything else about these four reports is proven at the service and HTTP layers, which is the
 * right place for the arithmetic. What no backend test can see is the part that was actually wrong:
 * the DEFAULT scope printing as an empty string after a separator, a totals row repeating the
 * indicators directly above it, and a sort control that no keyboard can reach. Those are only
 * observable in a rendered page.
 *
 * One login for all three report types, matching the per-surface convention: the Type selector swaps
 * the report in place, so paying three logins to see three of them would be three times the cost for
 * the same navigation.
 */

test.describe('Reports', () => {
  test('renders all three report types with a named scope and no duplicated totals', async ({
    page,
  }) => {
    await loginAndSelectProject(page)
    await page.goto('/reports', { waitUntil: 'domcontentloaded' })
    await settle(page)

    // ── Iteration Burndown (the default type) ───────────────────────────────
    // The centred context line, IB §7: `{Project Name} - {Team Name|All Teams}`. No Team is selected,
    // so this is the aggregate — and it used to render as "NX Platform - " with nothing after the
    // dash, which reads as a value still loading.
    await expect(page.getByText(/NX Platform - All Teams/)).toBeVisible({ timeout: 20_000 })

    // The chart's accessible equivalent. `sr-only` is visually hidden but present in the DOM and in
    // the accessibility tree, which is the whole point of using it over `display: none`.
    await expect(page.getByRole('table', { name: /Iteration Burndown as a table/ })).toBeAttached()

    const type = page.getByLabel('Type', { exact: true })

    // ── Velocity ────────────────────────────────────────────────────────────
    await type.selectOption('velocity')
    await settle(page)
    // Velocity §6: `Team: {Team Name|All Teams}`.
    await expect(page.getByText('Team: All Teams')).toBeVisible()
    await expect(page.getByRole('table', { name: /Velocity as a table/ })).toBeAttached()
    /**
     * Phase 7 SU-09 AC5 — the excluded segment NAMES ITSELF, in words, on the rendered page.
     *
     * The chart is `aria-hidden` and an amber stack segment cannot say why it is outside the trend, so
     * the legend label is the requirement: "Split / Carryover (excluded)". Asserted on the legend AND
     * as a column of the accessible table, because the point of the pair is that a screen reader gets
     * the same fourth number a sighted reader sees.
     *
     * Rendered whether or not this project's window contains a Split — it is a segment of a stack
     * whose scale every bar shares, so a key that came and went would change the chart's meaning
     * between two renders of the same report.
     */
    await expect(page.getByText('Split / Carryover (excluded)').first()).toBeVisible()
    await expect(
      page.getByRole('columnheader', { name: 'Split / Carryover (excluded)' }),
    ).toBeAttached()

    // ── Team Capacity ───────────────────────────────────────────────────────
    await type.selectOption('capacity')
    await settle(page)
    // TC §6: "report name and selected Team scope".
    await expect(page.getByText('Team Capacity - All Teams')).toBeVisible()

    // The four indicators ARE the totals, so there is no totals row. It printed the same four numbers
    // from the same object, on the same screen, and §6's list of what the report contains has no
    // table footer in it.
    await expect(page.getByText('Capacity Hours')).toBeVisible()
    await expect(page.getByText('Totals', { exact: true })).toHaveCount(0)
  })
})

test.describe('Release Tracking', () => {
  test('sorts by keyboard, names an absent Team, and closes the issues panel', async ({ page }) => {
    await loginAndSelectProject(page)
    await page.goto('/release-tracking', { waitUntil: 'domcontentloaded' })
    await settle(page)

    /**
     * The scope is read-only CONTEXT (§239, RT-AC-02) and it lives in the app shell's context switcher —
     * `NXP · All Teams` — which is where Rally shows it and where it applies to every page.
     *
     * It used to be repeated as this page's subtitle. Two copies of one fact, and the page-level one read
     * as a filter belonging to Release Tracking, which RT-AC-02 forbids. Asserted here as the SHELL's
     * copy, so the requirement is still covered and the duplicate cannot come back unnoticed.
     */
    await expect(page.getByText(/NXP · All Teams/)).toBeVisible({ timeout: 20_000 })

    // The Release picker sits BESIDE the title, as Rally lays it out, rather than across the bar.
    await expect(page.getByRole('button', { name: /Previous release/i })).toBeVisible()

    /**
     * RT-AC-05 — "Rank, ID and Team sort both directions" — from the keyboard.
     *
     * The control was a `div` with `onClick`: not focusable, not operable by Enter or Space, and
     * announced as bare text. This header is shared by every grid in the app, so the same was true of
     * Backlog, Iteration Status and Team Status.
     */
    const idHeader = page.getByRole('button', { name: /^ID, / })
    await expect(idHeader).toBeVisible()
    await idHeader.focus()
    await page.keyboard.press('Enter')
    // The accessible name carries the direction a caret can only show.
    await expect(page.getByRole('button', { name: /^ID, sorted ascending/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /^ID, sorted descending/ })).toBeVisible()

    // The burnup's iteration band belongs to the x-axis (RT-AC-09), and the chart carries its data
    // as a table.
    await expect(page.getByRole('table', { name: /Burnup for .* as a table/ })).toBeAttached()

    /**
     * The mismatch panel's explicit close control.
     *
     * Outside-click still closes it (RT-AC-10) and that stays the behaviour — but it is not
     * discoverable, and for someone who opened the panel from the keyboard there was no way out that
     * returned focus to the trigger.
     */
    const badge = page.getByRole('button', { name: /assigned to a different release/i }).first()
    if (await badge.isVisible().catch(() => false)) {
      await badge.click()
      const close = page.getByRole('button', { name: 'Close', exact: true })
      await expect(close).toBeVisible()
      await close.click()
      await expect(close).toHaveCount(0)
    }
  })
})

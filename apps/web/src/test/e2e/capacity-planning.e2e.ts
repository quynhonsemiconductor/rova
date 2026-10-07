import { expect, test } from '@playwright/test'
import { loginAndSelectProject } from './helpers'

/**
 * Capacity planning (P5.2) — the three-state capacity cell.
 *
 * The behaviour worth driving through a browser is that cell: blank (not entered), an
 * explicit 0, and a real number are three DIFFERENT states in the schema and in every
 * later warning rule. A UI that collapsed blank into 0 would look correct while quietly
 * reporting teams as fully committed.
 *
 * Uses the SEEDED plan (`db/seeds/demo.ts` — "NX Platform v2 capacity", Team Alpha added
 * with capacity NULL) rather than creating one. A release may hold only one plan
 * (`uq_capacity_plan_project_release`), so a test that created its own would consume the
 * project's only unplanned release and fail on its second run — which is exactly what the
 * first draft of this spec did. Plan CREATION is covered by `capacity-plans.e2e.spec.ts`
 * against real SQL, where uniqueness and the CHECK constraints can be asserted directly.
 */
test.describe('Capacity Planning', () => {
  /**
   * The Team Alpha row.
   *
   * Filtered by the team name rather than taking the first `div.group`: the column HEADER
   * cells carry that class too, so `.first()` lands on the "Team" header. The sidebar's
   * Total Capacity is not a `.group` at all, which keeps it out of the way.
   */
  const teamRow = (page: import('@playwright/test').Page) =>
    page.locator('div.group').filter({ hasText: 'Team Alpha' }).first()

  async function openSeededPlan(page: import('@playwright/test').Page) {
    await loginAndSelectProject(page)
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })
    // The ID cell is the link: the row does not navigate and the NAME cell edits in place,
    // which is how Rally and every other grid here behave.
    // CP-1 by name, not `.first()`: the seed now also carries CP-2, a PUBLISHED plan, and the list
    // is newest-first — so `.first()` opened the read-only one and every draft-only control was
    // missing.
    await page.getByRole('link', { name: /^CP-1$/ }).click()
    await expect(page).toHaveURL(/\/capacity-planning\/[0-9a-f-]{36}/)
    await expect(page.getByText('Team Alpha').first()).toBeVisible()
  }

  /**
   * Open the capacity editor.
   *
   * `InlineEditableCell` puts its `aria-label` on the EDIT INPUT only — the resting cell is
   * a plain span — so the cell is reached by its visible text and the input by its name.
   */
  async function editCapacity(page: import('@playwright/test').Page) {
    // Scoped to the LAST numeric cell, not the first: the row now carries a Features count as
    // well, and `.first()` matched that instead of the capacity cell.
    await teamRow(page)
      .getByText(/Not entered|^\d+ points$|^\d+$/)
      .last()
      .click()
    return page.getByRole('textbox', { name: /^Capacity for / })
  }

  test('sets a capacity, keeps 0 distinct from blank, and clears back to blank', async ({
    page,
  }) => {
    await openSeededPlan(page)

    // Establish the precondition rather than trusting the seeded value: any earlier spec or
    // manual poke that set a capacity would otherwise make this fail for the wrong reason.
    // Clearing is itself the behaviour under test, so this costs nothing.
    const reset = await editCapacity(page)
    await reset.fill('')
    await reset.press('Enter')
    await expect(teamRow(page)).toContainText('Not entered')

    // ── A real value ────────────────────────────────────────────────────────
    let editor = await editCapacity(page)
    await editor.fill('40')
    await editor.press('Enter')
    await expect(teamRow(page)).toContainText('40')
    await expect(teamRow(page)).not.toContainText('Not entered')

    // Persisted, not just held in local state.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(teamRow(page)).toContainText('40')

    // ── Zero is a REAL entered ceiling ──────────────────────────────────────
    editor = await editCapacity(page)
    await editor.fill('0')
    await editor.press('Enter')
    await expect(teamRow(page)).not.toContainText('Not entered')

    // ── Clearing returns to blank, NOT to zero ──────────────────────────────
    // Also restores the seeded state, so re-runs start where this one began.
    editor = await editCapacity(page)
    await editor.fill('')
    await editor.press('Enter')
    await expect(teamRow(page)).toContainText('Not entered')
  })

  test('warnings say WHICH rule fired, and Breakdown spells out the numbers', async ({ page }) => {
    await openSeededPlan(page)

    // Seeded Team Alpha has no capacity, which is Rally's own missing-capacity error. Reset
    // to blank first: this spec shares the plan with the capacity-editing test above, and a
    // leftover value would make the warning legitimately absent.
    const reset = await editCapacity(page)
    await reset.fill('')
    await reset.press('Enter')
    await expect(teamRow(page)).toContainText('Not entered')

    // The glyph carries the reason as its accessible name — before this slice it was an
    // unlabelled triangle, so "something is wrong" was the entire message.
    const glyph = teamRow(page).getByRole('img', { name: /No capacity entered/ })
    await expect(glyph).toBeVisible()

    // ── Breakdown ───────────────────────────────────────────────────────────
    // Rally's panel, not a modal table: four bars on one scale, each labelled with its value and
    // annotated with the GAP to the level above — Complete, then Unfinished, then two Remainings.
    await page.getByRole('button', { name: 'Breakdown', exact: true }).click()
    const panel = page.getByText('By Story Points')
    await expect(panel).toBeVisible()
    for (const label of [
      'Complete',
      'Rollup',
      'Estimated',
      'Capacity',
      'Unfinished',
      'Remaining',
    ]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
    }
    // Esc closes a popover; there is no dialog to find a Close button in.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    // Entering a capacity clears that warning — the plan is now measurable. Restores the
    // seeded blank afterwards so re-runs start where this began.
    let editor = await editCapacity(page)
    await editor.fill('500')
    await editor.press('Enter')
    await expect(teamRow(page)).toContainText('500')
    await expect(teamRow(page).getByRole('img', { name: /No capacity entered/ })).toHaveCount(0)

    editor = await editCapacity(page)
    await editor.fill('')
    await editor.press('Enter')
    await expect(teamRow(page)).toContainText('Not entered')
  })

  test('Calculate Capacity Forecast reports three lines or names why it cannot', async ({
    page,
  }) => {
    await openSeededPlan(page)

    await teamRow(page)
      .getByRole('button', { name: /Forecast capacity for/ })
      .click()
    const dialog = page.getByRole('dialog', { name: /Calculate capacity forecast/i })
    await expect(dialog).toBeVisible()

    // ── The guard runs client-side, before any request ───────────────────────
    await dialog.getByLabel(/Team availability/).fill('0')
    await dialog.getByRole('button', { name: 'Calculate', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()

    // ── A real calculation ───────────────────────────────────────────────────
    // Asserted as an ALTERNATION on purpose. The seeded Story's schedule state is mutated by
    // other specs in this suite, so whether Team Alpha has accepted history is genuinely
    // run-order dependent — but the tool must answer either way, with numbers or with a named
    // reason. Which branch produces which number is pinned in `capacity-forecast.spec.ts`
    // (22 cases) and `capacity-forecast.e2e.spec.ts` (real SQL).
    await dialog.getByLabel(/Team availability/).fill('100')
    await dialog.getByRole('button', { name: 'Calculate', exact: true }).click()
    await expect(
      dialog.getByText(/Delivered 50% of the time|not finished an iteration|Less than 14 days/),
    ).toBeVisible()

    // ── A velocity the PLANNER supplies ──────────────────────────────────────
    // The BA's version of this dialog: it "proposes capacities from a supplied historic
    // velocity" (SRS:142), so the number is an input and not a derivation. Unlike the sampled
    // branch above this is NOT run-order dependent — the planner's own number does not depend
    // on whether another spec mutated the seeded Story's schedule state.
    await dialog.getByLabel(/Historic velocity per iteration/).fill('0')
    await dialog.getByRole('button', { name: 'Calculate', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()

    await dialog.getByLabel(/Historic velocity per iteration/).fill('30')
    await dialog.getByRole('button', { name: 'Calculate', exact: true }).click()
    // Either the proposal, or the one named reason a supplied velocity can still fail: with no
    // iteration dates anywhere there is no cadence to spread it over.
    await expect(
      dialog.getByText(/From the velocity you supplied|cannot be spread over/),
    ).toBeVisible()

    // Nothing was written: the capacity cell is still blank until a line is adopted.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(teamRow(page)).toContainText('Not entered')
  })

  test('the plan list renders its columns and the seeded plan', async ({ page }) => {
    await loginAndSelectProject(page)
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })

    // Rally's columns, and only those: Unit, Target Load and Capacity are plan SETTINGS, so they
    // live on the detail page rather than telling two rows apart here.
    for (const column of ['ID', 'Name', 'Release', 'Status', 'Last Updated', 'Teams in Plan']) {
      await expect(page.getByLabel(`${column} column`, { exact: true })).toBeVisible()
    }
    for (const gone of ['Unit', 'Target Load', 'Capacity']) {
      await expect(page.getByLabel(`${gone} column`, { exact: true })).toHaveCount(0)
    }
    await expect(page.getByText('NX Platform v2 capacity')).toBeVisible()
    // The plan's key leads the row and is the only cell that navigates.
    await expect(page.getByRole('link', { name: /^CP-1$/ })).toBeVisible()
  })

  test('the create dialog will not offer a release that already has a plan', async ({ page }) => {
    // The seeded release is the project's only one and already carries a plan, so the
    // picker must be empty and say so rather than letting the user submit and take a 409.
    await loginAndSelectProject(page)
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: /Add New/i }).click()
    const dialog = page.getByRole('dialog', { name: 'New Capacity Plan' })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText('Every release in this project already has a plan.'),
    ).toBeVisible()
  })
})

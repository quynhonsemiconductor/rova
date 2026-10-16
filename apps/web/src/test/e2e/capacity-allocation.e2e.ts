import { expect, test } from '@playwright/test'
import { loginAndSelectProject } from './helpers'

/**
 * Capacity allocation (P5.2 slice 5) — the allocate loop and the tier badge.
 *
 * Works on the SEEDED plan ("NX Platform v2 capacity", Team Alpha) and cleans up after
 * itself, so it is repeatable: a release may hold only one plan, so a test that created its
 * own would consume the project's only unplanned release.
 *
 * The tier badge is the piece most worth driving through a browser. The same number means
 * different things depending on where it came from — a committed allocation, a top-down
 * refined estimate, or a T-shirt size mapped by workspace settings — and the badge is the
 * only thing on screen that says which.
 */
test.describe('Capacity allocation', () => {
  /** Click the first option in an open `SearchableSelect` (a Radix popover of buttons). */
  async function pickOption(page: import('@playwright/test').Page, label: string | RegExp) {
    const popover = page.locator('[data-radix-popper-content-wrapper]')
    await popover.waitFor()
    await popover.getByRole('button', { name: label }).first().click()
  }

  /** The seeded team's row. `.first()` avoids the column header, which shares `.group`. */
  const teamRow = (page: import('@playwright/test').Page) =>
    page.locator('div.group').filter({ hasText: 'Team Alpha' }).first()

  /**
   * Types a capacity for ONE team, addressed by name.
   *
   * The editor is a single shared textbox, so clicking a cell in one row and then filling "the"
   * textbox is only unambiguous while one row is open — a loop over rows kept writing to the wrong
   * team. The cell's accessible name carries the team, which makes each write addressable.
   */
  async function setCapacity(page: import('@playwright/test').Page, team: string, value: string) {
    // Through the team's ROW, by TEXT: the capacity cell's resting state is text, not a button —
    // `InlineEditableCell` only renders the input (and its accessible name) once clicked. The row
    // scopes the click; the editor that opens is the grid's single shared textbox.
    const row = page.locator('div.group').filter({ hasText: team }).first()
    await row
      .getByText(/Not entered|^\d+ points$|^\d+$/)
      .last()
      .click()
    const box = page.getByRole('textbox', { name: /^Capacity for / })
    await box.fill(value)
    await box.press('Enter')
    await expect(box).toHaveCount(0)
  }

  /**
   * Disclose a team's allocated Features.
   *
   * Rally collapses them by default, so every assertion about an allocation row has to open its
   * team first. Idempotent: if it is already open the toggle reads "Collapse…" and this is a
   * no-op rather than a close.
   */
  async function expandTeam(page: import('@playwright/test').Page, team = 'Team Alpha') {
    const collapse = page.getByRole('button', {
      name: new RegExp(`Collapse the Features allocated to ${team}`),
    })
    // The Teams tab first: allocating happens on the Features tab now (Rally's own placement), so a
    // test that just allocated is standing on the other tab when it comes to read the result.
    const teamsTab = page.getByRole('tab', { name: /Teams/ })
    if ((await teamsTab.getAttribute('aria-selected')) !== 'true') await teamsTab.click()

    if (await collapse.count()) return // already open

    const expand = page.getByRole('button', {
      name: new RegExp(`Expand the Features allocated to ${team}`),
    })
    // Waited for, then confirmed: the row re-renders when the allocate mutation refetches, so a
    // fire-and-forget click can land on a node that is about to unmount and do nothing at all.
    await expect(expand).toBeVisible()
    await expand.click()
    await expect(collapse).toBeVisible()
  }

  /**
   * Opens the Allocate dialog from where Rally's plan keeps it: the Features tab's own action row.
   *
   * Not the header menu — that holds only Edit Plan Details and Delete Plan, the things you do to a
   * plan once. `expandTeam` switches back when a test needs the team view again.
   */
  /**
   * Opens the plan's `Actions` menu, where Rally keeps `Publish` and `Unpublish`.
   *
   * A helper because every publish step in this file starts with it: the menu is the only route to
   * those two verbs, so a spec that clicked a toolbar button was asserting a layout Rally does not
   * have.
   */
  async function planAction(page: import('@playwright/test').Page, name: RegExp) {
    await page.getByRole('button', { name: 'Plan actions' }).click()
    await page.getByRole('button', { name }).click()
  }

  async function allocateFeature(
    page: import('@playwright/test').Page,
    feature: RegExp,
    team: RegExp | null,
    estimate?: string,
  ) {
    // Rally's two acts, in order. `Add Features` puts the Feature ON the plan (unassigned); the
    // Feature's own `Allocate to teams` then distributes it. One dialog used to do both, which is
    // why "add" and "allocate" had become the same word.
    await page.getByRole('tab', { name: /Features/ }).click()

    // The seeded plan already carries FE-1 and FE-2, and the picker deliberately omits what is
    // already on the plan — so add only when the row is not there yet.
    const row = page.getByRole('button', { name: new RegExp(`Actions for ${feature.source}`) })
    if ((await row.count()) === 0) {
      await page.getByRole('button', { name: 'Add Features' }).click()
      const add = page.getByRole('dialog', { name: /Add Features to this plan/i })
      // The row LABEL is the target: the shared picker's checkbox carries no accessible name of its
      // own, and clicking the label is what a user does anyway.
      await add.getByText(feature).first().click()
      await add.getByRole('button', { name: 'Add to Plan' }).click()
      await expect(add).toBeHidden()
    }

    if (team === null) return // stays in the Unallocated bucket

    await page
      .getByRole('button', { name: new RegExp(`Actions for ${feature.source}`) })
      .first()
      .click()
    await page.getByRole('button', { name: 'Allocate to teams' }).click()
    const dialog = page.getByRole('dialog', { name: 'Allocate to Teams' })
    // Rally's table dialog: it opens on the Feature's CURRENT split, so allocating to a NEW team
    // means adding a row rather than overwriting the one already there.
    const rows = dialog.getByRole('button', { name: 'Team' })
    const unset = dialog.getByRole('button', { name: 'Team' }).filter({ hasText: 'Select team' })
    if ((await unset.count()) === 0 && (await rows.count()) > 0) {
      const addRow = dialog.getByRole('button', { name: 'Add team' })
      if (await addRow.count()) await addRow.click()
    }
    const targetRow = (await unset.count()) > 0 ? unset.first() : rows.last()
    await targetRow.click()
    await pickOption(page, team)
    if (estimate !== undefined) await dialog.getByLabel('Estimate').last().fill(estimate)
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(dialog).toBeHidden()
  }

  /**
   * Removes a Feature from the plan the way Rally does: the per-item menu on the Features tab.
   *
   * There is no per-row trash in a team's sub-table — that would remove the Feature from one team
   * while leaving it on the plan, which is a different decision.
   */
  async function removeFeature(page: import('@playwright/test').Page, key: string) {
    await page.getByRole('tab', { name: /Features/ }).click()
    await page
      .getByRole('button', { name: new RegExp(`Actions for ${key}`) })
      .first()
      .click()
    await page.getByRole('button', { name: 'Remove from plan' }).click()
    await page.getByRole('tab', { name: /Teams/ }).click()
  }

  async function openPlan(page: import('@playwright/test').Page) {
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
    await resetPlan(page)
  }

  /**
   * Returns the ONE seeded plan to a known board: draft, no Features, no capacity.
   *
   * These tests share a plan because a release holds only one, so a test that created its own would
   * consume the project's only unplanned release. Sharing means every test inherits whatever the
   * last one left — and a test that fails midway leaves the plan PUBLISHED, at which point every
   * later test starves waiting for draft-only controls. Resetting on entry costs four UI steps and
   * removes that entire class of failure.
   */
  async function resetPlan(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: 'Plan actions' }).click()
    const unpublish = page.getByRole('button', { name: /^Unpublish$/ })
    if (await unpublish.count()) {
      await unpublish.click()
      await page.getByRole('dialog').getByRole('button', { name: 'Unpublish' }).click()
    } else {
      await page.keyboard.press('Escape')
    }

    await page.getByRole('tab', { name: /Features/ }).click()
    // Bounded: the seed puts two Features on the plan and a test adds at most a couple more.
    for (let i = 0; i < 8; i++) {
      const menu = page.getByRole('button', { name: /Actions for FE-/ })
      if ((await menu.count()) === 0) break
      await menu.first().click()
      await page.getByRole('button', { name: 'Remove from plan' }).click()
      await page.waitForTimeout(400)
    }

    await page.getByRole('tab', { name: /Teams/ }).click()
    // Both seeded teams, by name: the seed gives Team Beta a real ceiling, so a plan total that
    // still counts it makes the cutline test's "runs out of capacity" premise false.
    for (const team of ['Team Alpha', 'Team Beta']) {
      const row = page.locator('div.group').filter({ hasText: team }).first()
      if ((await row.count()) > 0 && !/Not entered/.test((await row.textContent()) ?? '')) {
        await setCapacity(page, team, '')
      }
    }
  }

  test("allocates a Feature to a team, shows Rally's Estimate panel, then removes it", async ({
    page,
  }) => {
    await openPlan(page)

    // ── Add, then allocate ──────────────────────────────────────────────────
    // Estimate left blank on purpose: §185 copies the Feature's own top-down estimate into the row and
    // labels its source `Feature Estimate`.
    await allocateFeature(page, /FE-1/, /Team Alpha/)

    // ── The allocated row appears under its team, naming where its number came from ──
    await expandTeam(page)
    const row = page.locator('div.group').filter({ hasText: 'Guest checkout flow' }).first()
    await expect(row).toBeVisible()
    /**
     * The trailing glyph carries Rally's `Estimate` panel as its accessible name: the three candidates
     * in Rally's order with the one in force ticked, then the allocation's own source.
     *
     * FE-1 is preliminary `M` with no Refined forecast, so a blank Estimate copied 5 — Allocated 5 wins,
     * Refined is an em dash and Preliminary's equal 5 is beaten. Matched against a screenshot of the
     * real product's team tab.
     */
    await expect(
      row.getByRole('img', { name: /^Estimate: Allocated 5 ✓, Refined —, Preliminary 5\./ }),
    ).toBeVisible()
    await expect(row.getByRole('img', { name: /Feature Estimate$/ })).toBeVisible()

    // Survives a reload: the allocation was persisted, not just held in cache. Expansion is
    // local state, so the reload collapses the team again — reopen it.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expandTeam(page)
    await expect(
      page.locator('div.group').filter({ hasText: 'Guest checkout flow' }).first(),
    ).toBeVisible()

    // ── Remove it, restoring the seeded state for the next run ───────────────
    await removeFeature(page, 'FE-1')
    await expect(page.getByText('Guest checkout flow')).toHaveCount(0)
  })

  test('draws the cutline where the team runs out of capacity', async ({ page }) => {
    // Rally's line: Features in rank order, above it fits, below it does not. Needs a real
    // capacity AND two Features that straddle it, so this builds both and puts the seeded plan
    // back the way it found it.
    await openPlan(page)

    // A plan capacity small enough that the demand straddles it. The cutline measures the PLAN's
    // total, so Beta's ceiling has to be part of the arrangement rather than left to whatever the
    // seed chose — 0 is a real state ("this team takes no committed demand"), not a blank.
    await setCapacity(page, 'Team Alpha', '5')
    await setCapacity(page, 'Team Beta', '0')
    await expect(teamRow(page)).toContainText('5')

    // `openPlan` reset the board, so these are the only two Features on the plan: 4 points each,
    // the first fits inside 5, the second does not — so the line falls between them.
    for (const feature of [/FE-1/, /FE-2/]) {
      await allocateFeature(page, feature, /Team Alpha/, '4')
    }

    // The cutline lives on the FEATURES tab, against the PLAN's total capacity — Rally draws it
    // there and nowhere else. The Teams tab must not show one. (Allocating happens on the Features
    // tab now, so this has to walk back to Teams before asserting the absence.)
    await page.getByRole('tab', { name: /Teams/ }).click()
    await expect(page.getByRole('separator', { name: /Capacity cutline/i })).toHaveCount(0)

    await page.getByRole('tab', { name: /Features/ }).click()
    await expect(page.getByRole('separator', { name: /Capacity cutline/i })).toBeVisible()
    // Exactly one Feature is marked as not fitting — the second.
    await expect(page.locator('[data-below-cutline="true"]')).toHaveCount(1)

    // Survives a reload: the index came from the API, not from local state.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: /Features/ }).click()
    await expect(page.getByRole('separator', { name: /Capacity cutline/i })).toBeVisible()
    // Back to Teams, where the allocations are removed.
    await page.getByRole('tab', { name: /Teams/ }).click()

    // ── Restore the seeded state ─────────────────────────────────────────────
    await expandTeam(page)
    for (const key of ['FE-1', 'FE-2']) {
      await removeFeature(page, key)
    }
    const reset = await (async () => {
      await teamRow(page)
        .getByText(/Not entered|^\d+ points$|^\d+$/)
        .last()
        .click()
      return page.getByRole('textbox', { name: /^Capacity for / })
    })()
    await reset.fill('')
    await reset.press('Enter')
    await expect(teamRow(page)).toContainText('Not entered')
  })

  test('publishes the plan, reports what it wrote, then reverts without undoing it', async ({
    page,
  }) => {
    // The riskiest action in Phase 5 driven end to end, on the SEEDED plan. Cleans up after
    // itself in both directions — the allocation is removed and the plan is returned to draft —
    // because a release holds only one plan, so a test that created its own would consume the
    // project's only unplanned release.
    await openPlan(page)

    // Allocate FE-1 to Team Alpha so there is something to publish.
    await allocateFeature(page, /FE-1/, /Team Alpha/)

    // ── Publish ──────────────────────────────────────────────────────────────
    // From the Actions menu, which is where Rally puts it.
    await planAction(page, /^Publish$/)
    const dialog = page.getByRole('dialog', { name: /Publish this plan/i })
    // The three things a planner has to know BEFORE the write: what lands, when the Release
    // lands, and that reverting will not undo it.
    //
    // Each matched SPECIFICALLY. `/planned start and end dates/` alone used to identify the first
    // line only because the Release rule said "falls inside its release"; `P5-CAP-AC-019` (retest
    // 2026-08-17) replaced that with the equality wording, which names the same dates — so the loose
    // pattern matched two elements and the assertion could no longer tell the two facts apart.
    await expect(dialog.getByText(/takes this plan.s planned start and end dates/)).toBeVisible()
    await expect(
      dialog.getByText(/exactly match the selected Release start and end dates/),
    ).toBeVisible()
    await expect(dialog.getByText(/does NOT undo these field values/)).toBeVisible()
    // Rally's second option is offered alongside, not hidden behind a checkbox.
    await expect(
      dialog.getByRole('button', { name: 'Publish without updating fields' }),
    ).toBeVisible()

    await dialog.getByRole('button', { name: 'Publish and update fields' }).click()
    await expect(dialog).toBeHidden()

    // Published plans are read-only, so the editing affordances go away.
    // A published plan offers no Allocate: the action row drops it rather than failing the request.
    await page.getByRole('tab', { name: /Features/ }).click()
    await expect(page.getByRole('button', { name: /^Allocate to teams$/ })).toHaveCount(0)
    await page.getByRole('tab', { name: /Teams/ }).click()
    // …and the Actions menu offers `Unpublish` where `Publish` was.
    await page.getByRole('button', { name: 'Plan actions' }).click()
    await expect(page.getByRole('button', { name: /^Unpublish$/ })).toBeVisible()
    await page.keyboard.press('Escape')

    // ── The Feature really took the plan's window ────────────────────────────
    // Read from the Portfolio detail rather than the plan, which is the whole point: the
    // publish wrote to a row on another page. The seeded plan mirrors its release's window.
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    await page.getByRole('searchbox', { name: /Search portfolio/i }).fill('Guest checkout flow')
    await page.getByText('FE-1', { exact: true }).click()
    await expect(page).toHaveURL(/\/portfolio\/[0-9a-f-]{36}/)
    await expect(page.getByText('2026-07-01')).toBeVisible()
    await expect(page.getByText('v2.0 — NX Platform Upgrade')).toBeVisible()

    // ── Unpublish, which does NOT roll the fields back ───────────────────────
    await page.goBack()
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })
    // The ID cell is the link: the row does not navigate and the NAME cell edits in place,
    // which is how Rally and every other grid here behave.
    // CP-1 by name, not `.first()`: the seed now also carries CP-2, a PUBLISHED plan, and the list
    // is newest-first — so `.first()` opened the read-only one and every draft-only control was
    // missing.
    await page.getByRole('link', { name: /^CP-1$/ }).click()
    await planAction(page, /^Unpublish$/)
    const confirm = page.getByRole('dialog')
    await expect(confirm.getByText(/are NOT undone/)).toBeVisible()
    await confirm.getByRole('button', { name: 'Unpublish' }).click()

    // Editable again.
    await page.getByRole('button', { name: 'Plan actions' }).click()
    await expect(page.getByRole('button', { name: /^Publish$/ })).toBeVisible()
    await page.keyboard.press('Escape')

    // Clean up: remove the allocation, restoring the seeded state. The Feature KEEPS the
    // release and dates the publish wrote, which is Rally's behaviour and is what the backend
    // e2e asserts against real SQL.
    await expandTeam(page)
    await removeFeature(page, 'FE-1')
    await expect(page.getByText('Guest checkout flow')).toHaveCount(0)
  })

  test('parks demand as `Not assigned` on the Features tab when no team is chosen', async ({
    page,
  }) => {
    await openPlan(page)

    // `Add Features` alone: Rally's added rows land UNASSIGNED, so this never opens Allocate.
    await allocateFeature(page, /FE-2/, null)

    /**
     * On the FEATURES tab, not in a bucket on Teams by Total.
     *
     * The BA removed that block on 2026-07-28: a Feature with no team "has no dedicated Unallocated
     * Features block on Teams by Total — the plan header still counts it under Unassigned, and it
     * appears in the Features tab carrying a `Not assigned` badge". Both of those are what this now
     * checks, because they are the two places the state is actually reported.
     */
    await page.getByRole('tab', { name: /Features/ }).click()
    await expect(page.getByText('Saved payment methods')).toBeVisible()
    await expect(page.getByText('Not assigned')).toBeVisible()
    await expect(page.getByText(/1 Unassigned/)).toBeVisible()

    // …and the Teams tab no longer carries a bucket for it.
    await page.getByRole('tab', { name: /Teams/ }).click()
    await expect(page.getByText('Unallocated')).toHaveCount(0)

    // Clean up.
    await removeFeature(page, 'FE-2')
    await expect(page.getByText('Saved payment methods')).toHaveCount(0)
  })

  test('moves a Feature to another plan, and offers only DRAFT destinations', async ({ page }) => {
    /**
     * Rally's `Move To Another Plan`, driven end to end between the two SEEDED plans: CP-1 (draft,
     * v2.0) and CP-2 (v2.1, published in the seed).
     *
     * A PUBLISHED plan is not a destination. Moving demand into one would unpublish it behind the
     * planner's back, contradicting the published snapshot everyone downstream is reading — so the
     * dialog lists drafts only, and the `Move and republish the plan` button that used to paper over
     * it is gone. This test proves both halves: CP-2 is absent while published, and the move works
     * once it is a draft.
     *
     * Cleans up after itself — moves the Feature back and republishes CP-2 — because the two plans
     * are shared with every other test in this file.
     */
    await openPlan(page)
    await allocateFeature(page, /FE-1/, /Team Alpha/, '5')

    const openMove = async () => {
      await page.getByRole('tab', { name: /Features/ }).click()
      await page
        .getByRole('button', { name: /Actions for FE-1/ })
        .first()
        .click()
      await page.getByRole('button', { name: 'Move to another plan' }).click()
      return page.getByRole('dialog', { name: 'Move To Another Plan' })
    }

    // ── Nothing to move to yet: CP-1 is this plan, CP-2 is published ─────────
    const closed = await openMove()
    await expect(closed.getByRole('checkbox', { name: /^CP-1$/ })).toHaveCount(0)
    await expect(closed.getByRole('checkbox', { name: /^CP-2$/ })).toHaveCount(0)
    await closed.getByRole('button', { name: 'Cancel' }).click()

    // ── Make CP-2 a draft, which is what makes it eligible ───────────────────
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })
    await page.getByRole('link', { name: /^CP-2$/ }).click()
    await planAction(page, /^Unpublish$/)
    await page.getByRole('dialog').getByRole('button', { name: 'Unpublish' }).click()
    await expect(page.getByText('Draft')).toBeVisible()

    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })
    await page.getByRole('link', { name: /^CP-1$/ }).click()

    const dialog = await openMove()
    await expect(dialog.getByRole('checkbox', { name: /^CP-1$/ })).toHaveCount(0)
    await dialog.getByRole('checkbox', { name: /^CP-2$/ }).click()

    // CP-2 belongs to another release, so the checkbox is not optional — the dialog says so BEFORE
    // the click, and the API refuses the move without it.
    await expect(dialog.getByText(/belongs to another release/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Move', exact: true }).click()
    // The dialog's own ALERT, not a text match: the checkbox hint and the toast both say "another
    // release" too, so a bare `getByText` matched three nodes and failed strict mode.
    await expect(dialog.getByRole('alert')).toContainText(/another release/)

    await dialog
      .getByRole('checkbox', { name: 'Update the Release to match the selected plan' })
      .click()
    await dialog.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(dialog).toBeHidden()

    // Gone from CP-1 — the move relocated the rows rather than copying them.
    await expect(page.getByRole('button', { name: /Actions for FE-1/ })).toHaveCount(0)

    // ── On CP-2: the Feature arrived, and the plan is still a draft ──────────
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })
    await page.getByRole('link', { name: /^CP-2$/ }).click()
    await page.getByRole('tab', { name: /Features/ }).click()
    await expect(page.getByRole('link', { name: 'FE-1' }).first()).toBeVisible()
    await expect(page.getByText('Draft')).toBeVisible()

    // ── Cleanup: move it back to CP-1, then restore CP-2's published state ───
    await page
      .getByRole('button', { name: /Actions for FE-1/ })
      .first()
      .click()
    await page.getByRole('button', { name: 'Move to another plan' }).click()
    const back = page.getByRole('dialog', { name: 'Move To Another Plan' })
    await back.getByRole('checkbox', { name: /^CP-1$/ }).click()
    await back
      .getByRole('checkbox', { name: 'Update the Release to match the selected plan' })
      .click()
    await back.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(back).toBeHidden()

    await planAction(page, /^Publish$/)
    const publish = page.getByRole('dialog', { name: /Publish this plan/i })
    await publish.getByRole('button', { name: 'Publish without updating fields' }).click()
    await expect(publish).toBeHidden()

    // And CP-1 has it back, parked: its team is not on CP-2, so the return trip cannot restore one.
    await page.goto('/capacity-planning', { waitUntil: 'domcontentloaded' })
    await page.getByRole('link', { name: /^CP-1$/ }).click()
    await page.getByRole('tab', { name: /Features/ }).click()
    await expect(page.getByRole('link', { name: 'FE-1' }).first()).toBeVisible()
    await removeFeature(page, 'FE-1')
  })
})

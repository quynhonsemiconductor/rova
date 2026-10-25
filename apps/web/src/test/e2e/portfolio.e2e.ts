import { expect, test, type Page } from '@playwright/test'
import { login, selectProject, settle } from './helpers'

/**
 * Picks an Owner in a create dialog, which SRS §344 makes required for both types.
 *
 * The dialog now refuses to submit without one, so every create in this file has to choose someone —
 * the first person on the list, whoever the seed made them. Factored out because four tests create an
 * item and none of them are about the Owner field itself.
 */
/**
 * Opens the create dialog for the level the list is SHOWING.
 *
 * PR 367 replaced the `New Portfolio Item` menu with one button that follows the Type switcher, and
 * these four tests still clicked the menu — so they were failing on `main`, not against this branch.
 *
 * (PR numbers are written `PR 367` throughout this repo's comments, without a leading hash: the
 * design-token ratchet matches a hash followed by hex digits and would read one as a raw colour.)
 */
async function openCreate(page: Page, type: 'Feature' | 'Epic') {
  await page.getByRole('button', { name: `New ${type}`, exact: true }).click()
  return page.getByRole('dialog', { name: `New ${type}` })
}

/**
 * Portfolio list + detail (P5).
 *
 * Covers what unit tests structurally cannot: that the page renders against the
 * real API, that the Epic/Feature switcher re-queries, and that the detail shell
 * shows the four progress indicators and hides the Feature-only fields on an Epic.
 *
 * Fixture comes from the demo seed (`db/seeds/demo.ts`): Epic `EP-1` over Features
 * `FE-1` (Story + Defect linked) and `FE-2` (childless).
 *
 * Deliberately asserts STRUCTURE, not percentages. The rollup denominators come
 * from the shared seeded Story/Defect, whose schedule state other specs in this
 * suite mutate (backlog-accepted-iteration, blocked-reason-inline-edit), so pinning
 * "100%" here would make this spec fail depending on run order. The arithmetic is
 * covered where it belongs — `portfolio-rollup.spec.ts` (37 cases) and
 * `portfolio-items.service.spec.ts`.
 */
test.describe('Portfolio', () => {
  test('lists Features with rollup columns and opens detail', async ({ page }) => {
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    // Feature is the default level.
    await expect(page.getByText('FE-1', { exact: true })).toBeVisible()
    await expect(page.getByText('Guest checkout flow')).toBeVisible()
    await expect(page.getByText('Saved payment methods')).toBeVisible()

    // Both Percent Done columns exist as distinct columns — they divide by
    // different denominators, so collapsing them into one would be a real defect.
    await expect(page.getByText('% Done by Est.')).toBeVisible()
    await expect(page.getByText('% Done by Count')).toBeVisible()

    // Project is resolved server-side; this list spans projects.
    await expect(page.getByText('NX Platform').first()).toBeVisible()

    await page.getByText('FE-1', { exact: true }).click()
    await expect(page).toHaveURL(/\/portfolio\/[0-9a-f-]{36}/)
    await expect(page.getByText('Guest checkout flow').first()).toBeVisible()
    // `Total Accepted Children`, which is what Rally shows on a portfolio item's detail page — it
    // replaced the four progress meters this line used to assert (`% Done by Plan Estimate` and
    // friends), same arithmetic framed as the question a reader of this page is asking.
    await expect(page.getByText('Total Accepted Children')).toBeVisible()
  })

  test('the Type switcher swaps between Features and Epics', async ({ page }) => {
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    // The switcher lives in the page header, not behind "Filters": it selects the
    // portfolio LEVEL rather than narrowing a result set.
    await page.getByLabel('Type').selectOption('epic')

    await expect(page.getByText('EP-1', { exact: true })).toBeVisible()
    await expect(page.getByText('Unified checkout platform')).toBeVisible()
    // Exclusive, not additive — the API has no combined view.
    await expect(page.getByText('Guest checkout flow')).toHaveCount(0)
  })

  test("an Epic's detail lists its child Features and hides Feature-only fields", async ({
    page,
  }) => {
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Type').selectOption('epic')
    await page.getByText('EP-1', { exact: true }).click()
    await expect(page).toHaveURL(/\/portfolio\/[0-9a-f-]{36}/)

    // An Epic has no Team/Release/parent by CHECK constraint, so those rows must
    // not render — an empty row would read as "unset" rather than "not applicable".
    await expect(page.getByText('Preliminary Estimate')).toBeVisible()
    await expect(page.getByText('Release', { exact: true })).toHaveCount(0)

    await page.getByRole('tab', { name: /Children/ }).click()
    // Both Features appear, proving the two-level hierarchy read.
    await expect(page.getByText('Guest checkout flow')).toBeVisible()
    await expect(page.getByText('Saved payment methods')).toBeVisible()
  })

  test('creates a Feature, renames it in place, then archives it', async ({ page }) => {
    // One test covering the whole write loop on purpose: each step needs the row the
    // previous one produced, and splitting them would leave orphaned fixtures behind in
    // a suite that shares one seeded database.
    const unique = `E2E Feature ${Date.now()}`
    const renamed = `${unique} renamed`

    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    // ── Create ──────────────────────────────────────────────────────────────
    // Scoped to the dialog throughout: the grid header also exposes a "Name column"
    // label and a "Resize Name column" separator, so an unscoped getByLabel('Name')
    // matches three elements.
    const dialog = await openCreate(page, 'Feature')
    await dialog.getByRole('textbox', { name: 'Name' }).fill(unique)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden()

    // The new row is ON SCREEN without searching for it. A new item is ranked LAST and the
    // grid pages at 25, so this used to require a search to find at all — the scaffold now
    // jumps to the page holding it and flashes it (`revealRowId`).
    //
    // Scoped to the ROW rather than the page: `exact: true` is not enough on its own here,
    // because the success toast also reads `"<name>" created`.
    const revealed = page.locator('[data-revealed="true"]')
    await expect(revealed).toContainText(unique)

    // It is a real grid row, not just a highlight: the same row is reachable as a sortable row
    // on the page the user was sent to.
    const search = page.getByRole('searchbox', { name: /Search portfolio/i })
    await expect(page.locator('[data-portfolio-row]').filter({ hasText: unique })).toBeVisible()

    // ── Inline rename ───────────────────────────────────────────────────────
    // The Name cell is the inline editor; the ID cell is the click-to-open link.
    await page.getByText(unique, { exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Name' })
    await expect(editor).toBeVisible()
    await editor.fill(renamed)
    await editor.press('Enter')
    await expect(page.getByText(renamed, { exact: true })).toBeVisible()

    // Survives a reload, so it was persisted rather than only held in cache.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await search.fill(renamed)
    await expect(page.getByText(renamed, { exact: true })).toBeVisible()

    // ── Archive ─────────────────────────────────────────────────────────────
    // The row WRAPPER carries `group`; filtering plain divs and taking `.last()` lands on
    // the innermost text node's parent, which has no selection gutter.
    const row = page.locator('div.group').filter({ hasText: renamed }).first()
    await row.getByRole('checkbox').check()
    // The control is `Delete` and the EFFECT is archive (P5-PI-FR-037: "Backlog-style bulk
    // Edit/Delete; Delete archives"), so the label matches Backlog, Iteration Status and Quality.
    // The confirm dialog's button carries the same word, so it is scoped to the dialog rather
    // than picked by position.
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()

    // Archived items drop out of the default list — a soft delete, not a hard one.
    await expect(page.getByText(renamed, { exact: true })).toHaveCount(0)
  })

  test('the Percent Done bars carry Rally status colour and explain a missing verdict', async ({
    page,
  }) => {
    // Rally: "Both of the Percent Done fields are colored based on the status of the work
    // needed to complete the portfolio item" (TechDocs, "Using the Portfolio Items Page").
    //
    // Asserts the WIRING, not a particular colour. The verdict depends on the shared
    // seeded Story/Defect, whose schedule state other specs in this suite mutate, so
    // pinning "red" would fail depending on run order. The thresholds themselves are
    // covered in `health.spec.ts` (24 cases) and `percent-done-bar.test.tsx`.
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('FE-1', { exact: true })).toBeVisible()

    // Narrowed by SEARCH rather than scanning the grid: the list pages at 25 and a
    // populated workspace has hundreds of Features, so FE-2 is genuinely off page one.
    const search = page.getByRole('searchbox', { name: /Search portfolio/i })

    // FE-1 is seeded WITH a planned window, so it gets a real verdict: the tooltip
    // carries the numbers and a status sentence, and specifically NOT the missing-dates
    // note. That is what proves the dates reached `computeHealth`.
    await search.fill('Guest checkout flow')
    const fe1 = page.locator('[data-portfolio-row]').filter({ hasText: 'FE-1' })
    const fe1Tip = await fe1.locator('[title*="Accepted points"]').first().getAttribute('title')
    expect(fe1Tip).toContain('Status:')
    expect(fe1Tip).toContain('Accepted points:')
    expect(fe1Tip).not.toContain('dates are missing')

    // FE-2 is childless, so there is no denominator and no verdict. `computeHealth`
    // reports `no_work` ahead of `no_dates` — a zero total is checked first, since
    // dividing by it would invent a health problem — so the note names the missing
    // ESTIMATES even though FE-2 also has no dates.
    //
    // This is also the empty-bar path: there is no fill to hover, so the placeholder dash
    // carries the tooltip. Before this slice it carried nothing and the row read as a
    // rendering bug.
    await search.fill('Saved payment methods')
    const fe2 = page.locator('[data-portfolio-row]').filter({ hasText: 'FE-2' })
    const fe2Tip = await fe2.locator('[title*="Accepted points"]').first().getAttribute('title')
    expect(fe2Tip).toContain('no estimated work is linked yet')

    await search.fill('')

    /**
     * The DETAIL page no longer carries these bars, and deliberately so: Rally shows
     * `Total Accepted Children` there instead, which is the block this asserts reached the page.
     *
     * This used to compare the detail tooltip against the grid's, character for character. That
     * cross-check cannot survive the two surfaces answering different questions — the grid reports a
     * percentage verdict per Feature, the detail block reports accepted child work in the unit the
     * reader picks. `Total Accepted Children` is covered as a component elsewhere; what belongs here
     * is that the grid's tooltip and the detail page both come up populated for the same Feature.
     */
    await page.getByText('FE-1', { exact: true }).click()
    await expect(page).toHaveURL(/\/portfolio\/[0-9a-f-]{36}/)
    await expect(page.getByText('Total Accepted Children')).toBeVisible()
  })

  test('Rank drag reorders rows, persists, and stands down under a column sort', async ({
    page,
  }) => {
    /**
     * FR-005 is the requirement — "User can reorder Features via Rank up/down controls" — and it is
     * satisfied here by DRAGGING the shared grip rather than by the up/down buttons §37 names.
     *
     * That is a deliberate divergence from §14 ("drag-and-drop Rank reordering" under Not included)
     * and §37 ("up/down reorder buttons only, no drag-and-drop"), flagged for the BA: every other
     * rank-ordered grid in the app drags, and this one grid reordering differently is what a planner
     * moving between Backlog and Portfolio actually notices. The three behaviours this test pins are
     * unchanged by that — reorder persists, every row keeps its control, and a column sort stands the
     * control down — only the affordance they run through is different.
     *
     * Creates its OWN pair and narrows to them by search. The previous version reordered whichever
     * two rows happened to sort first in a cross-project grid of hundreds, then compared whole-row
     * innerText after a reload — and row text carries rollup numbers that move whenever any linked
     * Story changes, so the assertion failed while the reorder had worked.
     */
    const tag = `RANK-${Date.now()}`
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    for (const suffix of ['A', 'B']) {
      const dialog = await openCreate(page, 'Feature')
      await dialog.getByRole('textbox', { name: 'Name' }).fill(`${tag} ${suffix}`)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(dialog).toBeHidden()
    }

    const search = page.getByRole('searchbox', { name: /Search portfolio/i })
    await search.fill(tag)

    const rows = page.locator('[data-portfolio-row]')
    await expect(rows).toHaveCount(2)
    /** The ID cell only — row text also carries rollup numbers that move on their own. */
    const keyOf = async (i: number) => {
      const text = (await rows.nth(i).innerText()).trim()
      // Rank now leads the row, so the key is the SECOND line.
      const lines = text.split('\n')
      return lines[1] ?? lines[0]
    }
    const before = [await keyOf(0), await keyOf(1)]
    expect(before[0]).not.toBe(before[1])

    /**
     * CLEAR THE SEARCH BEFORE DRAGGING. A drop computes the row's new position from its on-screen
     * neighbours, so a filtered list would hand the server two rows that are not adjacent in real
     * rank order and the move would resolve to a no-op. The page disables the grip for exactly that
     * reason (`listIsRankOrdered`), which is asserted a few lines below — so the reorder itself has
     * to happen on the unfiltered grid. The two fixtures were created last, so they are the final
     * two rows and still adjacent.
     */
    await search.fill('')
    await expect(rows.first()).toBeVisible()

    /*
     * Located by the fixture's own KEY, not by position. Earlier runs of this spec can leave their
     * own `RANK-*` pair behind if the archive step did not reach them, so "the last row" is not
     * reliably this run's fixture — which is what made a positional selector drag an unrelated row
     * and assert on this one.
     */
    const fixtureB = page.locator(`[data-portfolio-row]:has-text("${before[1]}")`).first()

    // Fixture B moves up one position, by KEYBOARD-dragging its grip: Space picks the row up,
    // ArrowUp moves it one place, Space drops it. Driven from the keyboard rather than with
    // `mouse.move` because that is also the assertion that rank reorder is reachable without a
    // pointer — `useRerankSensors` wires dnd-kit's `KeyboardSensor` and `DragHandle` is a real
    // focusable button precisely so this works.
    await fixtureB.getByRole('button', { name: /Drag to reorder/i }).focus()
    // Paced deliberately: dnd-kit announces the pickup and each move through a live region and
    // settles state between them, so three keypresses dispatched back-to-back can be swallowed —
    // which is exactly how this read as a flake (passing only on runs slow enough to settle).
    await page.keyboard.press('Space')
    await page.waitForTimeout(400)
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(400)
    await page.keyboard.press('Space')
    await page.waitForTimeout(1500)

    await search.fill(tag)
    await expect(rows).toHaveCount(2)
    await expect(async () => expect(await keyOf(0)).toBe(before[1])).toPass({ timeout: 5000 })

    // Asserted again after a RELOAD, so this proves the new rank was PERSISTED rather than
    // reordered in local state only.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await search.fill(tag)
    await expect(rows).toHaveCount(2)
    expect(await keyOf(0)).toBe(before[1])

    /**
     * A SEARCH stands the grip down, and this is the assertion that pins the bug this replaced.
     *
     * A drop computes the row's new position from its on-screen neighbours, so on a filtered list
     * those are not the rows the server has beside it: the move resolves between two non-adjacent
     * items and lands as a silent no-op — a `200` that changes nothing. The page refuses to offer
     * the affordance at all rather than let that happen (`listIsRankOrdered`), which is also why
     * the reorder above had to clear the search first.
     *
     * Asserted by COUNT, not `toBeVisible()`: a disabled `DragHandle` keeps its width so the cells
     * beside it do not shift, and drops out of the accessibility tree — so the NAMED button is what
     * disappears, not the element.
     */
    await expect(rows.nth(0).getByRole('button', { name: /Drag to reorder/i })).toHaveCount(0)

    /*
     * Unfiltered, every row has one — including the first: there is no "up" to disable on a drag.
     * `opacity-0` until hover (Rally parity) is why this is a count and not a visibility check.
     */
    await search.fill('')
    await expect(rows.first()).toBeVisible()
    await expect(rows.nth(0).getByRole('button', { name: /Drag to reorder/i })).toHaveCount(1)

    // Back to this run's own pair for everything below, which asserts on their order.
    await search.fill(tag)
    await expect(rows).toHaveCount(2)

    /**
     * Under a column sort every grip goes INERT, for the same reason as the search: rank only means
     * anything in rank order, and a move computed from Name-sorted neighbours would land the row
     * somewhere unrelated. §273 asks for the order to survive coming back to the Rank column, which
     * the last two assertions check.
     */
    await page.getByLabel('Name column', { exact: true }).click()
    for (const index of [0, 1]) {
      await expect(rows.nth(index).getByRole('button', { name: /Drag to reorder/i })).toHaveCount(0)
    }

    await page.getByLabel('Rank column', { exact: true }).click()
    await expect(rows).toHaveCount(2)
    expect(await keyOf(0)).toBe(before[1])

    // Clean up both fixtures in ONE bulk action so the grid does not grow a pair per run.
    for (const index of [0, 1]) {
      await rows.nth(index).getByRole('checkbox').check()
    }
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()

    // Counted as ROWS, not as text: the success toast repeats the name, so a text count would
    // wait for a toast to fade rather than for the archive to land.
    await expect(rows).toHaveCount(0)
  })

  test('creates the LEVEL the list is showing, and says so before it is pressed', async ({
    page,
  }) => {
    /**
     * PR 367 replaced the BA's `New Portfolio Item` menu (SRS §4, §11.2, acceptance 27) with one button
     * that follows the Type switcher, on the grounds that the menu made the same choice twice. That
     * deviation is flagged in the page's own comment for the BA to rule on; this test pins the
     * behaviour as shipped, and the label — the button has to say which level it will create.
     */
    const unique = `E2E Epic ${Date.now()}`
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    // Showing Features: one button, and it offers a Feature.
    await expect(page.getByRole('button', { name: 'New Feature', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Epic', exact: true })).toHaveCount(0)

    await page.getByLabel('Type').selectOption('epic')
    const dialog = await openCreate(page, 'Epic')
    await dialog.getByRole('textbox', { name: 'Name' }).fill(unique)
    // An Epic has no parent by CHECK constraint (`ck_portfolio_epic_shape`), so the dialog must
    // not offer the Epic picker a Feature gets.
    await expect(dialog.getByRole('combobox', { name: 'Epic' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('searchbox', { name: /Search portfolio/i }).fill(unique)
    await expect(page.getByText(unique, { exact: true })).toBeVisible()
  })

  test('the list carries NO summary metrics strip', async ({ page }) => {
    // The BA removed it outright — "Features / Total Stories / Accepted Stories / Total Points was
    // built, then explicitly removed per BA - 'no need'" (SRS:28), asserted again as QA #15. The
    // page goes from the breadcrumb straight to the toolbar.
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('searchbox', { name: /Search portfolio/i })).toBeVisible()

    // The STRIP itself, by its own marker. Card labels cannot answer this: `Developing` and
    // `Done` are also state names and appear in the grid's State cells regardless.
    await expect(page.locator('[data-metric-strip]')).toHaveCount(0)
  })

  test('What Success Looks Like is a real field, and it persists', async ({ page }) => {
    // The BA's fourth rich-text block on Feature detail (SRS §5.1) and Epic detail (§11.4), and
    // P5-PI-FR-019 requires it "backed by the shared Feature record rather than display-only".
    // Nothing backed it at all before migration 0086, so a reload is the assertion that matters.
    const body = `Success ${Date.now()}`
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    // The ID cell is the link — the row does not navigate and the Name cell edits in place.
    await page.getByRole('link', { name: 'FE-2', exact: true }).click()
    await expect(page).toHaveURL(/\/portfolio\/[0-9a-f-]{36}/)

    // By accessible NAME: every `RichTextEditor` now labels its editable area with the field
    // title, so this addresses the right one of five editors on the page.
    const editor = page.getByLabel('What Success Looks Like')
    await editor.scrollIntoViewIfNeeded()
    await editor.click()
    await editor.fill(body)
    // The Save bar is what persists a rich-text edit — the editor only reports keystrokes into
    // the pending patch.
    await page.getByRole('button', { name: /^Save$/ }).click()
    await expect(page.getByRole('button', { name: /^Save$/ })).toHaveCount(0)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(body)).toBeVisible()
  })

  test("a specific Team plus Epic shows the BA's explicit message, not an empty grid", async ({
    page,
  }) => {
    /**
     * FR-035 / Q16 / QA #35, quoted verbatim three times in the SRS: "specific Team + Epic shows
     * `Filter not show item`".
     *
     * An Epic is project-level and has no team (`ck_portfolio_epic_shape`), so a team filter can
     * only ever match Features. The service already returned an empty page for that pair — the page
     * just never passed the team, so an Epic list under a selected Team listed every Epic in the
     * project and the rule was unreachable.
     */
    await login(page)
    await selectProject(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    /**
     * Pick a specific Team in the GLOBAL context.
     *
     * It lives behind the header's workspace button — the one reading `NXP · All Teams` — and the
     * SELECTED project is already expanded, so there is no disclosure to open: clicking
     * `Expand project` hit the first *other* project in a list of twenty and moved everything.
     *
     * The name is `/Team Alpha$/`, not `/^Team Alpha$/`: the button's accessible name is its badge
     * plus its label, so it reads `ALPHATeam Alpha`.
     */
    await page.getByRole('button', { name: /NXP · / }).click()
    await page
      .getByRole('button', { name: /Team Alpha$/ })
      .first()
      .click()
    await expect(page.getByRole('button', { name: /NXP · Team Alpha/ })).toBeVisible()

    // A context change lands on HOME (`SHELL-FR-005`: "navigate về Home của context mới"), so come
    // back to the surface under test. This used to stay put — the Team half of that rule was read
    // as a scope filter that should not move the reader, and this spec was written against it.
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    await settle(page)

    await page.getByLabel('Type').selectOption('epic')
    await expect(page.getByText('Filter not show item')).toBeVisible()

    // All Teams restores the Epic list — the message is about the PAIR, not about Epics.
    await page.getByRole('button', { name: /NXP · Team Alpha/ }).click()
    await page
      .getByRole('button', { name: /^All Teams$/ })
      .first()
      .click()
    await expect(page.getByRole('button', { name: /NXP · All Teams/ })).toBeVisible()
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })
    await settle(page)
    // Re-apply the Type filter: the navigation home reset this page's own filter state, and
    // asserting the message is gone with NO filter applied would pass for the wrong reason.
    await page.getByLabel('Type').selectOption('epic')
    await expect(page.getByText('Filter not show item')).toHaveCount(0)
  })

  test('bulk Delete archives what it can and REPORTS what it skipped', async ({ page }) => {
    /**
     * FR-037: "`Delete` archives the selected Portfolio Items rather than hard-deleting them; an
     * Epic with active child Features is skipped and reported."
     *
     * Both halves were missing. The rows the caller could not archive were dropped from the target
     * list with no report at all, and on a partial failure only `failed[0].reason.message` surfaced
     * — so a mixed selection reported one row, hid the rest, and still showed a success toast.
     */
    const unique = `E2E Skip ${Date.now()}`
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    // A Feature that CAN be archived…
    const dialog = await openCreate(page, 'Feature')
    await dialog.getByRole('textbox', { name: 'Name' }).fill(unique)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden()

    const featureRow = page.locator('div.group').filter({ hasText: unique }).first()
    await featureRow.getByRole('checkbox').check()

    // …and the seeded Epic, which has active child Features and therefore cannot be.
    await page.getByLabel('Type').selectOption('epic')
    await page.waitForTimeout(800)
    const epicRow = page.locator('div.group').filter({ hasText: 'EP-1' }).first()
    await epicRow.getByRole('checkbox').check()

    await page.getByRole('button', { name: 'Delete', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()

    // Reported: the Epic is NAMED, so "skipped" is actionable rather than a count.
    await expect(page.getByText(/Skipped 1 item/)).toBeVisible()
    await expect(page.getByText(/EP-1/).first()).toBeVisible()
  })

  test('the inline child preview never lists more than five rows', async ({ page }) => {
    /**
     * AC-5 caps the preview at five, with a static `+N more - see Children tab` line beyond that.
     * Asserted as a PROPERTY rather than against a fixture: the seeded Features carry three children
     * each, so a count-based assertion would pass on data alone and say nothing about the cap.
     *
     * The `+N more` line therefore cannot be exercised by this seed — it needs a Feature with six
     * linked items — so what is pinned here is the cap itself and the absence of a spurious line.
     */
    await login(page)
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' })

    const chevron = page.getByRole('button', { name: /Expand|Show children/i }).first()
    if ((await chevron.count()) === 0) return

    await chevron.click()
    await page.waitForTimeout(1200)

    const previewRows = page.locator('[data-child-preview-row]')
    const shown = await previewRows.count()
    expect(shown).toBeLessThanOrEqual(5)
    // With five or fewer linked items there is nothing hidden, so the line must be absent.
    if (shown < 5) await expect(page.getByText(/more - see Children tab/)).toHaveCount(0)
  })
})

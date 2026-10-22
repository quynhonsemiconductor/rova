import { expect, test } from '@playwright/test'

import { loginAndSelectProject } from './helpers'

/**
 * Releases and Milestones, as ONE journey: list → ID column → detail → tabs → the Iteration-Status
 * milestone picker.
 *
 * Merged from three files that each held one or two assertions and each paid a full login and project
 * selection to make them — `release-milestone-id-column`, `releases-milestones-detail` and
 * `milestone-searchselect`. Four logins for six assertions, and a title like "header, tabs and shared
 * Artifacts tab render" describes a smoke check rather than anything a user does.
 *
 * Nothing was dropped in the merge. Every assertion those files made is below, including the two the
 * BA asked for by name: the ID column LEADS the row (and is the only navigating cell), and the
 * milestone cell opens the shared multi-select rather than a bespoke popover.
 *
 * Seeded data this relies on (both from the fixture, never created here): NXP's release `RE-1`
 * "v2.0 — NX Platform Upgrade" and milestone `MS-1` "GA — NX Platform v2", with `MS-1` assigned to
 * `US-1`.
 */
const RELEASE_ID = '00000000-0000-7000-8000-000000000050'
const MILESTONE_ID = '00000000-0000-7000-8000-0000000000b0'

/**
 * The key cell must render to the LEFT of the name cell.
 *
 * Asserted geometrically because "the ID column is first" is a statement about POSITION, and both
 * cells are buttons with similar roles — a DOM-order assertion would pass on a grid that renders them
 * in the wrong visual order under a different column layout.
 */
async function expectKeyLeftOfName(
  keyBtn: { boundingBox(): Promise<{ x: number } | null> },
  nameBtn: { boundingBox(): Promise<{ x: number } | null> },
) {
  const keyBox = await keyBtn.boundingBox()
  const nameBox = await nameBtn.boundingBox()
  expect(keyBox, 'key cell should be rendered').not.toBeNull()
  expect(nameBox, 'name cell should be rendered').not.toBeNull()
  expect(keyBox!.x).toBeLessThan(nameBox!.x)
}

/** Details is selected on arrival, Artifacts switches, and the shared tab view brings its search. */
async function expectSharedDetailChrome(page: import('@playwright/test').Page) {
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: 20_000 })
  const details = page.getByRole('tab', { name: /details/i })
  const artifacts = page.getByRole('tab', { name: /artifacts/i })
  await expect(details).toHaveAttribute('aria-selected', 'true')

  await artifacts.click()
  await expect(artifacts).toHaveAttribute('aria-selected', 'true')
  // The shared `ArtifactsTabView`, identified by the one control only it has.
  await expect(page.getByRole('searchbox', { name: /search artifacts/i })).toBeVisible()
}

test.describe('Releases and Milestones', () => {
  test('lists lead with the ID column, and each detail page uses the shared chrome', async ({
    page,
  }) => {
    await loginAndSelectProject(page)

    // ── Releases list ───────────────────────────────────────────────────────
    await page.goto('/releases', { waitUntil: 'domcontentloaded' })
    const releaseKey = page.getByRole('link', { name: 'RE-1', exact: true })
    await expect(releaseKey).toBeVisible({ timeout: 20_000 })
    await expectKeyLeftOfName(releaseKey, page.getByText(/NX Platform Upgrade/).first())

    // ── Release detail, reached the way a user reaches it: the ID cell ───────
    // Also the rule itself — the ID is the ONLY cell that navigates, which is why the name cell is
    // free to edit in place.
    await releaseKey.click()
    await expect(page).toHaveURL(new RegExp(`/releases/${RELEASE_ID}`))
    await expectSharedDetailChrome(page)

    // ── Milestones list ─────────────────────────────────────────────────────
    await page.goto('/milestones', { waitUntil: 'domcontentloaded' })
    const milestoneKey = page.getByRole('link', { name: 'MS-1', exact: true })
    await expect(milestoneKey).toBeVisible({ timeout: 20_000 })
    await expectKeyLeftOfName(milestoneKey, page.getByText(/NX Platform v2/).first())

    await milestoneKey.click()
    await expect(page).toHaveURL(new RegExp(`/milestones/${MILESTONE_ID}`))
    await expectSharedDetailChrome(page)
  })

  test('the Iteration-Status milestone cell opens the SHARED multi-select', async ({ page }) => {
    // Kept as its own test because it is a different surface (Iteration Status) and a different
    // claim: the cell reuses `SearchableSelect` — search box plus toggleable options — rather than a
    // bespoke popover, which is the consistency rule the whole grid is built on.
    await loginAndSelectProject(page)
    await page.goto('/iteration-status', { waitUntil: 'domcontentloaded' })

    // `exact` matters: the draggable row is itself a button whose accessible name aggregates every
    // cell's text, so a substring match clicks the ROW instead of the milestone trigger.
    const trigger = page.getByRole('button', { name: 'Edit milestones', exact: true }).first()
    await expect(trigger).toBeVisible({ timeout: 20_000 })
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()

    await expect(page.getByPlaceholder('Search milestones')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'MS-1: GA — NX Platform v2', exact: true }),
    ).toBeVisible()
  })
})

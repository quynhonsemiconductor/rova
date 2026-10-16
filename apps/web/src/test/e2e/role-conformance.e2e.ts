/**
 * ROLE CONFORMANCE — the app as a per-project EDITOR sees it.
 *
 * Every other journey in this folder logs in as a Workspace Admin, whose `workspace:*` matches every
 * code and therefore cannot fail a project-tier gate. That single fixture choice is why three defects
 * survived to the day the BA asked to test a non-admin login:
 *
 *   • any 403 — including a background picker feed — hard-redirected the whole app to `/403`, so a
 *     reader was evicted from a page they legitimately owned;
 *   • six surfaces read the ADMINISTRATIVE project roster as their name/owner feed, which an Editor
 *     is refused, so Quality and every work-item detail were unopenable;
 *   • nothing selected an initial project, and every gate resolves against the SELECTED project — so
 *     a freshly granted Editor got the nav of a No Access user.
 *
 * None of those is subtle. All three were invisible because no journey ever ran as anyone else. This
 * file exists so that stays impossible, and it deliberately does NOT pre-seed `rally-context`: the
 * helper's `seedContext` shortcut is what hid the third one.
 *
 * SCOPE. This asserts the SHAPE the BA specified per role — which surfaces open, which are hidden,
 * and that no screen ejects the reader — not every field's state. The server side is measured
 * separately by `test/e2e/server-role-matrix.e2e.spec.ts`. A rule the BA has written but the app does
 * not yet follow belongs here as `test.fail()` with the quote, so the gap is DECLARED rather than
 * absent; the Release case below was exactly that until the fix landed and the marker came off.
 */
import { test, expect } from '@playwright/test'

import { EDITOR, login, settle } from './helpers'

/** Surfaces §3.2 gives an Editor: Backlog and US/DE/Task, Iteration Status, Quality, Team Status. */
const EDITOR_SURFACES = [
  { path: '/backlog', nav: 'Plan' },
  { path: '/iteration-status', nav: 'Track' },
  { path: '/team-status', nav: 'Track' },
  { path: '/quality/defects', nav: 'Quality' },
] as const

/**
 * Surfaces §3.2 marks Hidden for an Editor: `Plan > Timeboxes` (:82, :83), Portfolio Items (:85),
 * Capacity Planning (:86), Release Tracking and Reports (:87).
 */
const HIDDEN_SURFACES = [
  '/timeboxes',
  '/releases',
  '/milestones',
  '/portfolio',
  '/capacity-planning',
  '/reports',
  '/release-tracking',
] as const

test.describe('Role conformance — per-project Editor', () => {
  test('lands with a project selected, not in a No Access shell', async ({ page }) => {
    // The P0 this file was written for. With `project === null` every nav item and route guard
    // resolves against no project, so a granted Editor saw Home and Access Denied everywhere.
    // No `seedContext` — the app must choose for itself.
    await login(page, EDITOR, { seedContext: false })

    await expect(page.getByText('No project selected')).toBeHidden()
    // `Plan` is a dropdown TRIGGER, so it is a button with `aria-haspopup`, not a link — its CHILDREN
    // are the links. Its presence is the observable form of "a project is selected and its codes
    // resolved", because `navItemState` hides it until `work_item:view` resolves against a project.
    await expect(page.getByRole('button', { name: 'Plan' }).first()).toBeVisible()
  })

  test('opens every surface §3.2 grants, without being evicted', async ({ page }) => {
    // The 403-redirect defect: these pages fan out feeds an Editor may not read (an owner roster, a
    // release list), and a single one of those used to navigate the whole app to `/403` mid-render.
    await login(page, EDITOR, { seedContext: false })

    for (const surface of EDITOR_SURFACES) {
      await page.goto(surface.path, { waitUntil: 'domcontentloaded' })
      // Still on the page asked for — not `/403`, not `/login`.
      await expect(page).toHaveURL(new RegExp(surface.path.replace('/', '\\/')))
      await expect(page.getByRole('alert').filter({ hasText: /access/i })).toBeHidden()
    }
  })

  test('hides the nav entries §3.2 marks Hidden', async ({ page }) => {
    await login(page, EDITOR, { seedContext: false })

    for (const label of [
      'Portfolio Items',
      'Capacity Planning',
      'Reports',
      'Release Tracking',
      'Timeboxes',
    ]) {
      await expect(page.getByRole('link', { name: label, exact: true })).toBeHidden()
    }
  })

  test('renders Access Denied — not an empty grid — for a hidden surface typed as a URL', async ({
    page,
  }) => {
    // §7:197: "A known route without sufficient action permission shows Access Denied." An empty grid
    // is the failure this replaced: it reads as "this project has no data" rather than "not yours".
    await login(page, EDITOR, { seedContext: false })

    for (const path of HIDDEN_SURFACES) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 })
    }
  })

  test('gets Team Status READ-ONLY — every mutation control absent or disabled', async ({
    page,
  }) => {
    /**
     * `P3-TS-FR-039`: "Editor may access Team Status for assigned Project/Team scope in read-only
     * mode; Team Status mutation is rejected."
     *
     * The surface is granted (it is in EDITOR_SURFACES above) and the WRITE is not: `editor` holds
     * `team_status:view` and deliberately not `team_status:edit`, so the server answers 403. This
     * asserts the screen agrees — an offered control whose write is refused is the failure mode this
     * repo keeps finding, and the Task State dropdown is the one control on the row that carries the
     * write.
     */
    await login(page, EDITOR, { seedContext: false })
    await page.goto('/team-status', { waitUntil: 'domcontentloaded' })
    await settle(page)

    const stateControls = page.getByRole('combobox', { name: 'Task state' })
    for (let i = 0; i < (await stateControls.count()); i++) {
      await expect(stateControls.nth(i)).toBeDisabled()
    }
    // Capacity is the other mutation on this screen (`PATCH /team-status/capacity`). Its control is
    // an `InlineEditableCell`, which renders a plain span until clicked, so its absence for an
    // Editor is asserted where the affordance itself is observable — the unit test in
    // `team-status-page.test.tsx`, which counts `.inline-edit-cell`. Here the state dropdown is the
    // control a real Editor would reach for first.
  })

  test('opens a work item from Iteration Status without being evicted', async ({ page }) => {
    /**
     * The roster defect in its user-visible form: the work-item detail rail resolved its owner and
     * Feature labels from feeds an Editor is refused, so the page either rendered them blank or — with
     * the old global 403 handler — never opened at all.
     *
     * ITERATION STATUS, not Backlog, and that is a fixture fact rather than a preference: the seed's
     * Story and Defect are iteration-linked, and Backlog shows only `Unscheduled` rows (P2-BL §137),
     * so an Editor's Backlog is legitimately EMPTY here. Asserting a click on it would have tested the
     * fixture, not the role.
     */
    await login(page, EDITOR, { seedContext: false })
    await page.goto('/iteration-status', { waitUntil: 'domcontentloaded' })

    const firstId = page.getByRole('link', { name: /^(US|DE)-\d+$/ }).first()
    await firstId.click()
    await expect(page).toHaveURL(/\/item\//)
    await expect(page.getByRole('alert').filter({ hasText: /access/i })).toBeHidden()
  })

  test('does not offer the Release control an Editor may not use', async ({ page }) => {
    /**
     * The BA wrote this twice: `P3_RBAC_AND_SYSTEM_STATES.md:71` puts `Assign to Release` at Hidden for
     * an Editor, and `P4_SCREEN_ANNOTATIONS.md:47` says the aside field "must render as `H` (not merely
     * disabled)". `WorkItemsService.assertMayAssignRelease` refuses the write on `release:view`.
     *
     * This case was written as `test.fail()` while the control was still live, and the marker was
     * removed with the fix — recorded here because the sequence is the point: the assertion existed
     * before the behaviour, so the fix had something to satisfy rather than something to invent.
     *
     * What made it worse than an ordinary wrong state: the refusal arrived only on save, and it
     * discarded every OTHER pending edit in the same request.
     */
    await login(page, EDITOR, { seedContext: false })
    await page.goto('/iteration-status', { waitUntil: 'domcontentloaded' })
    await page
      .getByRole('link', { name: /^(US|DE)-\d+$/ })
      .first()
      .click()
    await expect(page).toHaveURL(/\/item\//)

    await expect(page.getByRole('combobox', { name: /release/i })).toBeHidden()
  })
})

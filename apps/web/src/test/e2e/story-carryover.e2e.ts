import { test, type Page } from '@playwright/test'

import { expect, loginAndSelectProject, settle } from './helpers'

/**
 * Story Target End Date + Carryover — ONE journey, end to end (Phase 7 CO, plan Task 12.1).
 *
 * The unit specs prove the picker, the modal and the reports with the network mocked, and the BE e2e
 * proves the transaction; this proves the SEAM: the real picker talking to the real routes against a
 * real database, through to the reports and the CSV download.
 *
 * FIXTURES (plan D13): strict team equality (R7) leaves the seed with no valid Carryover target, so
 * this spec creates its OWN Team Alpha Iterations and Story through the API before driving the UI.
 * All dates sit in March 2031 so the calendar opens on the right month, and the Story starts
 * `defined`, so it has no Start Date and the window opens at Sprint A's start (CO-BR-14). Names carry
 * a run suffix, so a re-run against the same database does not collide.
 */
const PROJECT_ID = '00000000-0000-7000-8000-000000000010'
const TEAM_ALPHA_ID = '00000000-0000-7000-8000-000000000040'

/**
 * A same-origin API call with the logged-in session. `page.request` shares the browser context's
 * cookies, and is immune to the page navigating underneath it (a `page.evaluate` fetch is not).
 */
async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const me = await page.request.get('/v1/bff/me')
  const { csrfToken } = (await me.json()) as { csrfToken?: string }
  const res = await page.request.fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`)
  return (await res.json()) as T
}

async function pickDay(page: Page, iso: string) {
  await page.getByRole('button', { name: 'Target End Date' }).click()
  await page.locator(`[data-date="${iso}"]`).click()
}

test.describe('Story Target End Date and Carryover', () => {
  test('saves in-sprint, cancels, carries over, traces, reports, exports and moves back', async ({
    page,
  }) => {
    // A long journey — seven steps, three page loads and a download — on a cold Vite server.
    test.setTimeout(180_000)
    await loginAndSelectProject(page)
    const run = Date.now().toString(36)

    // ── Fixtures through the API ─────────────────────────────────────────────
    const makeIteration = (name: string, startDate: string, endDate: string, state: string) =>
      api<{ id: string; name: string }>(page, 'POST', '/v1/iterations', {
        projectId: PROJECT_ID,
        teamId: TEAM_ALPHA_ID,
        name: `${name} ${run}`,
        state,
        startDate,
        endDate,
      })
    const a = await makeIteration('CO-A', '2031-03-03', '2031-03-14', 'committed')
    const b = await makeIteration('CO-B', '2031-03-17', '2031-03-28', 'planning')
    // Overlaps B, so 2031-03-26 resolves to TWO targets and the reader must choose (CO-BR-20).
    await makeIteration('CO-O', '2031-03-24', '2031-04-04', 'planning')

    const story = await api<{ id: string; itemKey: string }>(page, 'POST', '/v1/work-items', {
      projectId: PROJECT_ID,
      type: 'story',
      title: `Carryover journey ${run}`,
      teamId: TEAM_ALPHA_ID,
      scheduleState: 'defined',
    })
    await api(page, 'PATCH', `/v1/work-items/${story.id}`, { iterationId: a.id })
    await api(page, 'POST', `/v1/work-items/${story.id}/tasks`, {
      title: `Carryover task ${run}`,
      teamId: TEAM_ALPHA_ID,
      estimateHours: 8,
      todoHours: 5,
      actualHours: 2,
    })

    await page.goto(`/item/${story.itemKey}`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    const field = page.getByRole('button', { name: 'Target End Date' })
    // The first record load also compiles the Work Item page chunk on a cold Vite server.
    await expect(field).toBeVisible({ timeout: 60_000 })

    // ── 1. Inside the current Iteration → saved, no modal (CO-BR-17) ─────────
    // Sidebar edits are staged behind the page's Save/Cancel bar (Rally parity), so commit it.
    await pickDay(page, '2031-03-10')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(field).toContainText('2031-03-10', { timeout: 15_000 })
    await expect
      .poll(
        async () =>
          (await api<{ targetEndDate: string | null }>(page, 'GET', `/v1/work-items/${story.id}`))
            .targetEndDate,
      )
      .toBe('2031-03-10')

    // ── 2. A later date → modal → Cancel → nothing changed (CO-BR-18/25) ─────
    await pickDay(page, '2031-03-26')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('This User Story will carry over')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(field).toContainText('2031-03-10')
    const afterCancel = await api<{ iterationId: string }>(
      page,
      'GET',
      `/v1/work-items/${story.id}`,
    )
    expect(afterCancel.iterationId).toBe(a.id)

    // ── 3. Again → choose the target → Accept (CO-BR-20/22/23) ───────────────
    await pickDay(page, '2031-03-26')
    await expect(dialog.getByRole('button', { name: 'Accept & Carry Over' })).toBeDisabled()
    await dialog.getByRole('radio', { name: new RegExp(b.name) }).check()
    await dialog.getByRole('button', { name: 'Accept & Carry Over' }).click()
    await expect(dialog).toBeHidden({ timeout: 20_000 })
    await expect(field).toContainText('2031-03-26', { timeout: 15_000 })
    const carried = await api<{ id: string; iterationId: string }>(
      page,
      'GET',
      `/v1/work-items/${story.id}`,
    )
    expect(carried.id).toBe(story.id)
    expect(carried.iterationId).toBe(b.id)
    const taskRows = await api<Array<{ iterationId: string }>>(
      page,
      'GET',
      `/v1/work-items/${story.id}/tasks`,
    )
    expect(taskRows.every((t) => t.iterationId === b.id)).toBe(true)

    // ── 4. Revision History names the Carryover (CO-BR-44) ───────────────────
    await page.getByRole('tab', { name: /Revision History/i }).click()
    await expect(
      page.getByText(`accepted Carryover: ${a.name} → ${b.name} · Target End 2031-03-26`),
    ).toBeVisible({ timeout: 15_000 })

    // ── 5. Team Capacity badge → Carryover report (CO-BR-34) ─────────────────
    await page.evaluate(
      ({ iterationId, projectId }) => {
        localStorage.setItem(`rova-last-accessed-iteration:${projectId}`, iterationId)
        localStorage.setItem('rova-reports-type', 'capacity')
      },
      { iterationId: b.id, projectId: PROJECT_ID },
    )
    await page.goto('/reports', { waitUntil: 'domcontentloaded' })
    await settle(page)
    // First visit compiles the Reports chunk (recharts) on a cold Vite server.
    // A count, not `1`: a re-run's same-dated Sprint B joins this timebox group and is fused.
    await expect(page.getByText(/^Carry In \d+$/)).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'View report →' }).click()
    await expect(page.getByRole('cell', { name: story.itemKey })).toBeVisible({ timeout: 20_000 })

    // ── 6. Export the Carryover report as CSV (R1/R4) ───────────────────────
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export CSV' }).click()
    expect((await download).suggestedFilename()).toMatch(/^carryover-.+\.csv$/)

    // ── 7. Move it back manually → a Manual Move entry (CO-BR-26/27) ─────────
    await page.goto(`/item/${story.itemKey}`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.getByRole('button', { name: 'Iteration', exact: true }).click()
    const popover = page.locator('[data-radix-popper-content-wrapper]')
    await popover.waitFor()
    await popover
      .getByRole('button', { name: new RegExp(a.name) })
      .first()
      .click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await settle(page)
    await page.getByRole('tab', { name: /Revision History/i }).click()
    await expect(page.getByText(`moved Iteration (manual): ${b.name} → ${a.name}`)).toBeVisible({
      timeout: 15_000,
    })
    // The Carryover entry is still there, unchanged.
    await expect(page.getByText(/^accepted Carryover:/)).toBeVisible()
  })
})

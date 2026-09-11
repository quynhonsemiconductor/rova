import { test } from '@playwright/test'
import { login, selectProject, settle, expect } from './helpers'

/**
 * Back navigation from Test Result Detail used to corrupt the history stack.
 *
 * `test-result-detail-page.tsx` called `navigate({ to: '/test-case/$testCaseKey' })` directly
 * instead of walking history (`useDetailBack`, which every other detail page uses) — a hardcoded
 * forward navigation PUSHES a new stack entry rather than consuming one. So the actual sequence
 * was: Work Item -> Test Case -> Test Result -> Back (pushes a SECOND Test Case entry instead of
 * popping back to the first) -> Back again (walks ONE real entry, landing on the still-present
 * Test Result entry from the original visit, not Work Item).
 *
 * Fixture: seeded Story US-1 (`db/seeds/demo.ts`) carries Test Case TC-1, which carries Test
 * Results TR-1/TR-2.
 *
 * BLOCKED, not skipped: reaching Test Case Detail from Work Item Detail requires the Work Item's
 * own Test Cases tab (`test-cases-tab.tsx` — the only in-app link to `/test-case/$testCaseKey` in
 * the entire codebase, confirmed by grep), and that tab has a separate, pre-existing "Too many
 * re-renders" crash — reproduced on a clean `main` checkout with this session's changes stashed
 * out, so it predates and is unrelated to this fix. `page.goto('/test-case/TC-1')` is NOT an
 * equivalent substitute: it does not push a router-TRACKED history entry, so `useCanGoBack()`
 * reads `false` there and the second Back takes the deep-link fallback instead of walking the
 * real stack — silently testing the wrong thing rather than failing loudly, which is worse than
 * not running at all. There is no other in-app path to a Test Case's detail route.
 *
 * Left in place, `test.fixme`, for whoever fixes the Test Cases tab crash to un-skip.
 */
test.describe('Test Result Detail — back navigation', () => {
  test.fixme('a second Back lands on Work Item Detail, not back on Test Result Detail — BLOCKED by the Test Cases tab crash, see docblock', async ({
    page,
  }) => {
    await login(page)
    await selectProject(page)

    await page.goto('/item/US-1')
    await settle(page)
    await expect(page).toHaveURL(/\/item\/US-1$/)

    await page.getByRole('tab', { name: /Test Cases/i }).click()
    await settle(page)
    await page.getByRole('button', { name: 'TC-1' }).click()
    await settle(page)
    await expect(page).toHaveURL(/\/test-case\/TC-1$/)

    await page.getByRole('tab', { name: /Results/i }).click()
    await settle(page)
    // The Results tab's Build column links to the Test Result's own detail route.
    await page
      .getByRole('link', { name: /2026\.06\.2/ })
      .first()
      .click()
    await settle(page)
    await expect(page).toHaveURL(/\/test-result\//)

    // First Back: lands on Test Case Detail — this is what LOOKED correct before the fix too.
    await page.getByRole('button', { name: /back/i }).first().click()
    await settle(page)
    await expect(page).toHaveURL(/\/test-case\/TC-1$/)

    // Second Back: the actual regression. Before the fix, the first Back had pushed a
    // duplicate Test Case entry rather than popping one, so this landed back on Test Result
    // Detail instead of Work Item Detail.
    await page.getByRole('button', { name: /back/i }).first().click()
    await settle(page)
    await expect(page).toHaveURL(/\/item\/US-1$/)
  })
})

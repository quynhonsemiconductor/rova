import { type Page, test } from '@playwright/test'
import { expect, loginAndSelectProject, settle } from './helpers'

/**
 * US-119 — the official bilingual User Guide, opened from the top bar's Help icon.
 *
 * One journey for the surface, walking AC1 → AC4 in a single session, per the repo's per-surface rule.
 *
 * What this CANNOT cover, and where it is covered instead: the Vite dev server serves `public/guide`
 * as plain files, so neither the session gate (`functions/guide/_middleware.ts`) nor Cloudflare's
 * extensionless URLs exist here. Those are pinned by `functions/_lib/guide-gate.spec.ts` and
 * `src/test/user-guide.script.test.ts` respectively.
 */

// Pin the browser language: the Help icon chooses the guide edition from it (AC1 + decision 3).
test.use({ locale: 'en-US' })

async function expectNoBrokenAssets(guide: Page) {
  // AC4 — every screenshot decoded, and the guide's own stylesheet applied.
  await guide.waitForLoadState('load')
  const broken = await guide.$$eval('img', (imgs) =>
    imgs.filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src),
  )
  expect(broken).toEqual([])
  const styled = await guide.evaluate(() =>
    [...document.styleSheets].some((s) => s.href?.includes('styles.css') && s.cssRules.length > 0),
  )
  expect(styled).toBe(true)
}

test.describe('US-119 User Guide', () => {
  test('opens from the Help icon, switches language and navigates chapters', async ({
    page,
    context,
  }) => {
    await loginAndSelectProject(page)
    await page.goto('/backlog')
    await settle(page)

    // AC1 — the Help icon opens the guide in a NEW tab.
    const [guide] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: 'Open User Guide (opens in a new tab)' }).click(),
    ])
    await guide.waitForLoadState('domcontentloaded')
    await expect(guide).toHaveURL(/\/guide\/en\/index\.html/)

    // AC4 — the official version in the header, with assets intact.
    await expect(guide.locator('.brand-version')).toHaveText('Version 1.0')
    await expectNoBrokenAssets(guide)

    // AC2 — switch to Vietnamese: the counterpart page loads.
    await guide.locator('#guide-language').selectOption('vi')
    await guide.waitForURL(/\/guide\/index\.html/)
    await expect(guide.locator('html')).toHaveAttribute('lang', 'vi')
    await expect(guide.locator('.brand-version')).toHaveText('Phiên bản 1.0')

    // AC3 — the left menu moves to a chapter and highlights it.
    await guide.locator('.nav-item[href^="03-backlog-cong-viec.html"]').click()
    await guide.waitForURL(/\/guide\/03-backlog-cong-viec\.html/)
    await expect(guide.locator('.nav-item.active')).toHaveAttribute('href', '#chapter-03')
    await expect(guide.locator('.breadcrumb strong')).toHaveText(/^03\. /)
    await expectNoBrokenAssets(guide) // chapter 03 carries three production screenshots

    // AC3 — the "next" control moves on, and the highlight follows.
    await guide.locator('.chapter-nav-link.next').click()
    await guide.waitForURL(/\/guide\/04-testing\.html/)
    await expect(guide.locator('.nav-item.active')).toHaveAttribute('href', '#chapter-04')

    // AC2 — and back to English on a chapter keeps the chapter.
    await guide.locator('#guide-language').selectOption('en')
    await guide.waitForURL(/\/guide\/en\/04-testing\.html/)
    await expect(guide.locator('html')).toHaveAttribute('lang', /^en/)

    // AC1 — the Rova tab never moved.
    await expect(page).toHaveURL(/\/backlog$/)
  })
})

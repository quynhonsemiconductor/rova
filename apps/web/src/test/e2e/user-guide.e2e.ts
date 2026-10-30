import { type Page, test } from '@playwright/test'
import { expect, loginAndSelectProject, settle } from './helpers'

/**
 * US-119 — the bilingual User Guide, a page of the app at `/user-guide/<lang>/<chapter>#<section>`.
 *
 * One journey for the surface, per the repo's per-surface rule: Help → guide in the same tab →
 * language → chapter via the contents → next chapter → back to English → deep link to a section.
 *
 * What this CANNOT cover, and where it is covered instead: the Vite dev server serves
 * `public/guide-assets` as plain files and does not apply `public/_redirects`, so neither the session
 * gate in front of the guide's files nor the redirects from old `/guide/…` links exist here. Those are
 * pinned by `functions/_lib/guide-gate.spec.ts` and `src/test/user-guide-redirects.test.ts`; that the
 * build puts the guide's text behind the gate is `src/vite-guide-chunks.test.ts`.
 */

// Pin the browser language: `/user-guide` picks the edition from it.
test.use({ locale: 'en-US' })

/** Every screenshot on the chapter decoded. The count is pinned so "no images" cannot pass vacuously. */
async function expectScreenshots(page: Page, count: number) {
  const images = page.locator('img[src^="/guide-assets/"]')
  await expect(images).toHaveCount(count)
  for (const img of await images.all()) {
    await img.scrollIntoViewIfNeeded()
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true)
  }
}

test.describe('US-119 User Guide', () => {
  test('opens from Help in the same tab, switches language and moves between chapters', async ({
    page,
    context,
  }) => {
    await loginAndSelectProject(page)
    await page.goto('/backlog')
    await settle(page)

    // Help opens the guide IN PLACE (BA, 2026-10-30), in the browser's edition, on the start chapter.
    const pagesBefore = context.pages().length
    await page.getByRole('link', { name: 'Open User Guide' }).click()
    await expect(page).toHaveURL(/\/user-guide\/en\/00-bat-dau$/)
    expect(context.pages()).toHaveLength(pagesBefore)
    await expect(page.getByText('Version 1.0', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Work in the right scope from the start' }),
    ).toBeVisible()

    // Language: the same chapter in the Vietnamese edition, chrome included.
    await page.getByRole('combobox', { name: 'Select language' }).selectOption('vi')
    await expect(page).toHaveURL(/\/user-guide\/vi\/00-bat-dau$/)
    await expect(page.getByText('Phiên bản 1.0', { exact: true })).toBeVisible()

    // The contents move to a chapter and mark it current; its three screenshots load.
    const contents = page.getByRole('navigation', { name: 'Mục lục hướng dẫn' })
    await contents.getByRole('link', { name: /^03\s*Backlog & công việc/ }).click()
    await expect(page).toHaveURL(/\/user-guide\/vi\/03-backlog-cong-viec#chapter-03$/)
    await expect(contents.getByRole('link', { name: /^03\s*Backlog & công việc/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('navigation', { name: 'Đường dẫn' })).toContainText(
      '03. Backlog & công việc',
    )
    await expectScreenshots(page, 3)

    // "Next" moves on in reading order.
    await page
      .getByRole('navigation', { name: 'Điều hướng giữa các phần' })
      .getByRole('link', { name: /Phần sau/ })
      .click()
    await expect(page).toHaveURL(/\/user-guide\/vi\/04-testing#chapter-04$/)

    // Back to English keeps the chapter.
    await page.getByRole('combobox', { name: 'Chọn ngôn ngữ' }).selectOption('en')
    await expect(page).toHaveURL(/\/user-guide\/en\/04-testing/)
    await expect(page.getByRole('navigation', { name: 'Path' })).toContainText('04. Testing')

    // A shared link to a section lands on that section.
    await page.goto('/user-guide/en/05-lap-ke-hoach#trang-thai-iteration')
    await expect(page.locator('#trang-thai-iteration')).toBeInViewport()
  })
})

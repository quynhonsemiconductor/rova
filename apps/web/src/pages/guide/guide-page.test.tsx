/**
 * GuidePage — the URL it settles on, and what the reader can do from it.
 *
 * Through a real router with the app's route ids (`/auth/user-guide/$lang/$chapter`), so the claims
 * are about the URL the reader ends up on and the links they can follow, not about a mocked `Link`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import '@/shared/i18n/i18n'
import { chaptersOf } from './model/toc'
import { GuidePage } from './guide-page'
import { GuideLink } from './ui/guide-link'

async function renderGuide(path: string) {
  const rootRoute = createRootRoute({ component: Outlet })
  const authRoute = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: Outlet })
  const chapterRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/user-guide/$lang/$chapter',
    component: GuidePage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([authRoute.addChildren([chapterRoute])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  return router
}

const location = (router: Awaited<ReturnType<typeof renderGuide>>) =>
  `${router.state.location.pathname}${router.state.location.hash ? `#${router.state.location.hash}` : ''}`

describe('GuidePage', () => {
  // jsdom implements neither; the page scrolls its reading pane to the URL's section.
  const scrollIntoView = vi.fn()
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoView
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  })
  afterEach(() => scrollIntoView.mockReset())

  it('opens a chapter and lands on the section the URL names', async () => {
    await renderGuide('/user-guide/vi/01-lam-quen#doi-tuong-ke-hoach')
    expect(
      await screen.findByRole('heading', { name: 'Hiểu cấu trúc trước khi bắt đầu làm việc' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(scrollIntoView.mock.contexts).toContain(document.getElementById('doi-tuong-ke-hoach')),
    )
  })

  it('looks the section up in the reading pane, not in the whole document', async () => {
    // An element elsewhere in the app with the same id must not be what the guide scrolls to.
    const decoy = document.body.appendChild(document.createElement('div'))
    decoy.id = 'doi-tuong-ke-hoach'
    try {
      await renderGuide('/user-guide/vi/01-lam-quen#doi-tuong-ke-hoach')
      // The decoy comes first in the document, so a document-wide lookup would find it and never the
      // section. (The router's own hash scroll is document-wide and may also touch the decoy; that
      // moves the window, which this page does not scroll — the reading pane is what moves.)
      await waitFor(() =>
        expect(
          (scrollIntoView.mock.contexts as HTMLElement[]).some(
            (el) => el.tagName === 'SECTION' && el.id === 'doi-tuong-ke-hoach' && el !== decoy,
          ),
        ).toBe(true),
      )
    } finally {
      decoy.remove()
    }
  })

  it("rewrites the static guide's spelling of a chapter to its in-app URL", async () => {
    const router = await renderGuide('/user-guide/en/01-lam-quen.html#chapter-01')
    await waitFor(() => expect(location(router)).toBe('/user-guide/en/01-lam-quen#chapter-01'))
  })

  it("opens the static guide's start page as the start chapter", async () => {
    const router = await renderGuide('/user-guide/vi/index')
    await waitFor(() => expect(location(router)).toBe('/user-guide/vi/00-bat-dau'))
  })

  it("falls back to the reader's browser edition for an unknown one", async () => {
    // jsdom's navigator.languages is ['en-US'].
    const router = await renderGuide('/user-guide/fr/01-lam-quen')
    await waitFor(() => expect(location(router)).toBe('/user-guide/en/01-lam-quen'))
  })

  it('sends an unknown chapter to the start chapter', async () => {
    const router = await renderGuide('/user-guide/en/99-nope#somewhere')
    await waitFor(() => expect(location(router)).toBe('/user-guide/en/00-bat-dau'))
  })

  it('switches edition on the same chapter and section', async () => {
    const router = await renderGuide('/user-guide/vi/01-lam-quen#vi-du-xuyen-suot')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Chọn ngôn ngữ' }), {
      target: { value: 'en' },
    })
    await waitFor(() =>
      expect(location(router)).toBe('/user-guide/en/01-lam-quen#vi-du-xuyen-suot'),
    )
    expect(await screen.findByRole('combobox', { name: 'Select language' })).toHaveValue('en')
  })

  it('narrows the contents to what the search matches, ignoring Vietnamese accents', async () => {
    await renderGuide('/user-guide/vi/01-lam-quen')
    const contents = await screen.findByRole('navigation', { name: 'Mục lục hướng dẫn' })
    fireEvent.change(within(contents).getByRole('searchbox'), { target: { value: 'bao cao' } })

    // Chapter 10 "Báo cáo" matches by title, so it stays with every one of its sections…
    const reports = within(contents).getByRole('link', { name: /Báo cáo/ })
    expect(reports).toBeInTheDocument()
    // …and a chapter that matches nowhere is gone.
    expect(within(contents).queryByRole('link', { name: /Làm quen/ })).not.toBeInTheDocument()
  })

  it('keeps a chapter folded as the reader left it when a click on its toggle came during search', async () => {
    await renderGuide('/user-guide/en/01-lam-quen')
    const contents = await screen.findByRole('navigation', { name: 'Guide contents' })
    const toggle = within(contents).getByRole('button', { name: /Open items in Getting familiar/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true') // the chapter on screen starts open

    fireEvent.change(within(contents).getByRole('searchbox'), { target: { value: 'scope' } })
    fireEvent.click(toggle) // search holds it open: this click must not be remembered
    fireEvent.change(within(contents).getByRole('searchbox'), { target: { value: '' } })

    expect(
      within(contents).getByRole('button', { name: /Open items in Getting familiar/ }),
    ).toHaveAttribute('aria-expanded', 'true')
  })

  it('refuses to render a guide link outside the guide, rather than linking somewhere wrong', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<GuideLink hash="x">x</GuideLink>)).toThrow(/GuideContext/)
  })

  it("filters the start page's path cards with the same search", async () => {
    await renderGuide('/user-guide/en/00-bat-dau')
    const contents = await screen.findByRole('navigation', { name: 'Guide contents' })
    fireEvent.change(within(contents).getByRole('searchbox'), {
      target: { value: 'zzz-no-such-topic' },
    })
    expect(
      await screen.findByText('No matching topics were found in the current table of contents.'),
    ).toBeInTheDocument()
  })

  it('links to the next chapter in reading order', async () => {
    await renderGuide('/user-guide/en/00-bat-dau')
    const pager = await screen.findByRole('navigation', { name: 'Navigate between sections' })
    const next = chaptersOf('en')[1]!
    expect(within(pager).getByRole('link', { name: new RegExp(next.title) })).toHaveAttribute(
      'href',
      `/user-guide/en/${next.slug}#${next.anchor}`,
    )
  })
})

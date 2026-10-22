import '@/shared/i18n/i18n'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HelpLink } from './help-link'

function withBrowserLanguages(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
}

afterEach(() => vi.restoreAllMocks())

describe('HelpLink', () => {
  it('is a named link that opens the guide in a new tab, without an opener', () => {
    withBrowserLanguages(['en-US'])
    render(<HelpLink />)
    const link = screen.getByRole('link', { name: 'Open User Guide (opens in a new tab)' })
    expect(link).toHaveAttribute('href', '/guide/en/index.html')
    expect(link).toHaveAttribute('target', '_blank')
    // No hover tooltip (product decision, 2026-10-07); the accessible name comes from aria-label.
    expect(link).not.toHaveAttribute('title')
    expect(link.getAttribute('rel')?.split(/\s+/)).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    )
  })

  it('opens the Vietnamese guide for a Vietnamese browser', () => {
    withBrowserLanguages(['vi-VN', 'en'])
    render(<HelpLink />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/guide/index.html')
  })

  it('renders through the shared IconButton, which carries the target-size floor', () => {
    withBrowserLanguages(['en'])
    render(<HelpLink />)
    expect(screen.getByRole('link')).toHaveAttribute('data-slot', 'icon-button')
  })
})

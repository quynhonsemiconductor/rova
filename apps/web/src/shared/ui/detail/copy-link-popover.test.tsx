import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Real translations, so the assertions below name the labels a reader actually sees.
import '@/shared/i18n/i18n'
import { CopyLinkPopover } from './copy-link-popover'

const SUBJECT = {
  key: 'US-2',
  name: 'Allow Workspace Admin to be added as a Team member',
  url: 'https://rova.qnsc.vn/item/US-2',
}

function openPopover() {
  render(<CopyLinkPopover subject={SUBJECT} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
}

describe('CopyLinkPopover', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('offers the five rows, each showing the value it will copy', () => {
    openPopover()
    // Labelled inputs, so a reader can inspect and hand-select a long URL.
    expect(screen.getByLabelText('Link and Name')).toHaveValue(`US-2: ${SUBJECT.name}`)
    expect(screen.getByLabelText('Markdown Including Name')).toHaveValue(
      `[US-2: ${SUBJECT.name}](${SUBJECT.url})`,
    )
    expect(screen.getByLabelText('Markdown')).toHaveValue(`[US-2](${SUBJECT.url})`)
    expect(screen.getByLabelText('HTML')).toHaveValue(
      `<a href="${SUBJECT.url}">US-2: ${SUBJECT.name}</a>`,
    )
    expect(screen.getByLabelText('Plain')).toHaveValue(SUBJECT.url)
  })

  it('writes the plain rows with writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    openPopover()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy markdown$/i }))
    })
    expect(writeText).toHaveBeenCalledWith(`[US-2](${SUBJECT.url})`)
  })

  it('writes Link and Name as a rich hyperlink when ClipboardItem exists', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { write, writeText } })
    // Minimal stand-in: the component only needs the constructor to exist.
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public items: Record<string, Blob>) {}
      },
    )
    openPopover()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy link and name/i }))
    })
    expect(write).toHaveBeenCalledTimes(1)
    // The rich flavour is what makes it paste as a link rather than as its own source.
    const item = write.mock.calls[0][0][0] as { items: Record<string, Blob> }
    expect(Object.keys(item.items).sort()).toEqual(['text/html', 'text/plain'])
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to writeText where ClipboardItem is unavailable', async () => {
    const write = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { write, writeText } })
    vi.stubGlobal('ClipboardItem', undefined)
    openPopover()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy link and name/i }))
    })
    // A copy that silently does nothing is worse than a plain one.
    expect(writeText).toHaveBeenCalledWith(`US-2: ${SUBJECT.name}`)
    expect(write).not.toHaveBeenCalled()
  })

  it('dismisses via the X, as Rally does', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
    openPopover()
    expect(screen.getByLabelText('Plain')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    })
    expect(screen.queryByLabelText('Plain')).not.toBeInTheDocument()
  })

  it('marks the trigger open so the panel is visibly attached to it', () => {
    openPopover()
    // Radix drives this; the class keys off it to box the icon the way Rally does.
    expect(screen.getByRole('button', { name: 'Copy link' })).toHaveAttribute('data-state', 'open')
  })
})

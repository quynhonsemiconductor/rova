import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InlineEditableCell } from './inline-editable-cell'

describe('InlineEditableCell', () => {
  it('does not enter edit mode when canEdit is false', () => {
    render(<InlineEditableCell value="10" canEdit={false} onCommit={vi.fn()} />)
    fireEvent.click(screen.getByText('10'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('click enters edit mode, Enter commits the typed value', () => {
    const onCommit = vi.fn()
    render(<InlineEditableCell value="10" canEdit onCommit={onCommit} />)
    fireEvent.click(screen.getByText('10'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('20')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Escape cancels without committing', () => {
    const onCommit = vi.fn()
    render(<InlineEditableCell value="10" canEdit onCommit={onCommit} />)
    fireEvent.click(screen.getByText('10'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('10')).toBeTruthy()
  })

  it('dblclick trigger only enters edit mode on double click', () => {
    render(<InlineEditableCell value="x" canEdit trigger="dblclick" onCommit={vi.fn()} />)
    fireEvent.click(screen.getByText('x'))
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.doubleClick(screen.getByText('x'))
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  describe('newTabHref (US-120 AC1 — Ctrl+click Name opens the record in a new tab)', () => {
    const renderName = (newTabHref = '/item/US-50') => {
      const onCommit = vi.fn()
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      render(
        <InlineEditableCell value="Story" canEdit onCommit={onCommit} newTabHref={newTabHref} />,
      )
      return { open, cell: screen.getByText('Story') }
    }

    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Cmd', { metaKey: true }],
    ])('%s+click opens the URL in a new tab and does not edit', (_label, modifier) => {
      const { open, cell } = renderName()
      fireEvent.click(cell, modifier)
      expect(open).toHaveBeenCalledWith('/item/US-50', '_blank', 'noopener')
      expect(screen.queryByRole('textbox')).toBeNull()
      open.mockRestore()
    })

    it('middle-click opens the URL in a new tab', () => {
      const { open, cell } = renderName()
      fireEvent(cell, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      expect(open).toHaveBeenCalledWith('/item/US-50', '_blank', 'noopener')
      open.mockRestore()
    })

    it('a plain click still edits inline', () => {
      const { open, cell } = renderName()
      fireEvent.click(cell)
      expect(open).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox')).toBeTruthy()
      open.mockRestore()
    })

    it('ignores a URL that is not an in-app path', () => {
      const { open, cell } = renderName('javascript:alert(1)')
      fireEvent.click(cell, { ctrlKey: true })
      expect(open).not.toHaveBeenCalled()
      open.mockRestore()
    })
  })
})

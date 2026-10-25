/** US-120 — which clicks belong to the browser ("open elsewhere") and which are the app's. */
import { describe, expect, it } from 'vitest'
import { isNewTabClick } from './new-tab-click'

const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

describe('isNewTabClick', () => {
  it('is false only for a plain primary click', () => {
    expect(isNewTabClick(plain)).toBe(false)
  })

  it('is false for keyboard activation — Enter on a link fires a click with button 0, no modifiers', () => {
    const enter = new MouseEvent('click', { button: 0, detail: 0 })
    expect(isNewTabClick(enter)).toBe(false)
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['the middle button', { button: 1 }],
    ['the secondary button', { button: 2 }],
  ])('leaves %s to the browser', (_name, over) => {
    expect(isNewTabClick({ ...plain, ...over })).toBe(true)
  })
})

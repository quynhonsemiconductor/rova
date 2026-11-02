/** `WrapBox` keeps its own sizing classes AND the caller's layout classes on the one box. */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { WrapBox } from './wrap-box'

describe('WrapBox', () => {
  it("merges the caller's classes after its own", () => {
    const { container } = render(<WrapBox className="flex flex-col gap-0.5">x</WrapBox>)
    const box = container.firstElementChild as HTMLElement
    for (const cls of ['w-0', 'min-w-full', 'flex', 'flex-col', 'gap-0.5']) {
      expect(box.classList.contains(cls)).toBe(true)
    }
  })
})

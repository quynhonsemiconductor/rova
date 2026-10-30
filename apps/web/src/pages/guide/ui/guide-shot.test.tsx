/// <reference types="node" />
import '@/shared/i18n/i18n'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GUIDE_SHOTS, type GuideShotName } from '../model/shots'
import { GuideContext } from './guide-context'
import { GuideShot } from './guide-shot'

const ASSETS = join(import.meta.dirname, '../../../../public/guide-assets')

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string) {
  const bytes = readFileSync(join(ASSETS, file))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function renderShot(name: GuideShotName) {
  return render(
    <GuideContext.Provider value={{ lang: 'en', chapter: '02-truy-cap-pham-vi', query: '' }}>
      <GuideShot name={name} alt="Backlog screen" caption="The Backlog" />
    </GuideContext.Provider>,
  )
}

describe('GuideShot', () => {
  it('knows the true size of every screenshot, and of no file that is not there', () => {
    const files = readdirSync(ASSETS).filter((f) => f.endsWith('.png'))
    expect(Object.keys(GUIDE_SHOTS).sort()).toEqual(files.map((f) => f.slice(0, -4)).sort())
    for (const [name, size] of Object.entries(GUIDE_SHOTS)) {
      expect(pngSize(`${name}.png`), name).toEqual(size)
    }
  })

  it('reserves the image space before the gated file arrives', () => {
    renderShot('03-backlog-production')
    const img = screen.getByRole('img', { name: 'Backlog screen' })
    expect(img).toHaveAttribute('src', '/guide-assets/03-backlog-production.png')
    expect(img).toHaveAttribute('width', '940')
    expect(img).toHaveAttribute('height', '340')
  })

  it('says why, instead of a broken image, when the gate refuses the file', () => {
    renderShot('03-backlog-production')
    fireEvent.error(screen.getByRole('img', { name: 'Backlog screen' }))
    // Still announced by its description, and the caption stays.
    expect(screen.getByRole('img', { name: 'Backlog screen' }).tagName).toBe('DIV')
    expect(screen.getByText(/could not be loaded.*sign in again/)).toBeInTheDocument()
    expect(screen.getByText('The Backlog')).toBeInTheDocument()
  })
})

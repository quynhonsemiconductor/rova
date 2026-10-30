import { describe, expect, it } from 'vitest'
import { GUIDE_CHUNK_DIR, chunkFileName } from '../vite.config'

// The build writes every chunk carrying User Guide text under the session-gated `/guide-assets/js/`
// (see `functions/guide-assets/_middleware.ts`); everything else stays public under `/assets/`.
const chunk = (moduleIds: string[], isEntry = false) => ({ name: 'c', isEntry, moduleIds })
const SRC = '/repo/apps/web/src'

describe('chunkFileName', () => {
  it.each([
    [`${SRC}/pages/guide/content/vi/01-lam-quen.tsx`],
    [`${SRC}/pages/guide/content/en/12-viet-backlog-item.tsx`],
    [`${SRC}/pages/guide/model/toc.vi.ts`],
    ['D:\\repo\\apps\\web\\src\\pages\\guide\\model\\toc.ts'],
  ])('gates a chunk holding guide text (%s)', (id) => {
    expect(chunkFileName(chunk([`${SRC}/shared/ui/button.tsx`, id]))).toBe(
      `${GUIDE_CHUNK_DIR}/[name]-[hash].js`,
    )
  })

  it.each([
    [`${SRC}/pages/guide/model/guide-url.ts`],
    [`${SRC}/pages/guide/ui/parts/prose.tsx`],
    [`${SRC}/pages/backlog/backlog-page.tsx`],
    ['/repo/node_modules/react/index.js'],
  ])('leaves a chunk without guide text public (%s)', (id) => {
    expect(chunkFileName(chunk([id]))).toBe('assets/[name]-[hash].js')
  })

  it('refuses to put guide text in the entry, which signed-out visitors load', () => {
    expect(() => chunkFileName(chunk([`${SRC}/pages/guide/model/toc.ts`], true))).toThrow(
      /entry chunk/,
    )
  })
})

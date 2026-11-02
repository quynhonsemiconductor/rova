// @vitest-environment node
/// <reference types="node" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, type Rolldown } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import viteConfig, { GUIDE_CHUNK_DIR, chunkFileName, guideChunkGuard } from '../vite.config'

// The build writes every chunk carrying User Guide text under the session-gated `/guide-assets/js/`
// (see `functions/guide-assets/_middleware.ts`); everything else stays public under `/assets/`.
const SRC = '/repo/apps/web/src'

describe('chunkFileName', () => {
  it.each([
    [`${SRC}/pages/guide/content/vi/01-lam-quen.tsx`],
    [`${SRC}/pages/guide/content/en/12-viet-backlog-item.tsx`],
    [`${SRC}/pages/guide/model/toc.vi.ts`],
    ['D:\\repo\\apps\\web\\src\\pages\\guide\\model\\toc.ts'],
  ])('gates a chunk holding guide text (%s)', (id) => {
    expect(chunkFileName({ moduleIds: [`${SRC}/shared/ui/button.tsx`, id] })).toBe(
      `${GUIDE_CHUNK_DIR}/[name]-[hash].js`,
    )
  })

  it.each([
    [`${SRC}/pages/guide/model/guide-url.ts`],
    [`${SRC}/pages/guide/ui/parts/prose.tsx`],
    [`${SRC}/pages/backlog/backlog-page.tsx`],
    ['/repo/node_modules/react/index.js'],
  ])('leaves a chunk without guide text public (%s)', (id) => {
    expect(chunkFileName({ moduleIds: [id] })).toBe('assets/[name]-[hash].js')
  })
})

/**
 * Real builds, through Vite itself, of a three-file app shaped like ours — so what is under test is
 * the bundler's own call pattern (which file names an entry, which chunks an entry imports), not a
 * chunk object written by hand.
 */
describe("the app's build", () => {
  // The builds below take these two pieces by import; this pins that the app's own build uses them,
  // so dropping either from `vite.config.ts` fails here rather than shipping guide text in public.
  const app = viteConfig({ command: 'build', mode: 'production' })

  it('runs the entry guard', () => {
    expect(app.plugins).toContain(guideChunkGuard)
  })

  it('names chunks with chunkFileName', () => {
    expect(app.build?.rollupOptions?.output).toMatchObject({ chunkFileNames: chunkFileName })
  })
})

describe('a real build', () => {
  const roots: string[] = []
  afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

  async function buildApp(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'guide-chunks-'))
    roots.push(root)
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    const pages = Object.keys(files).filter((f) => f.endsWith('.html'))
    const output = (await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [guideChunkGuard],
      build: {
        write: false,
        rollupOptions: {
          input: Object.fromEntries(
            pages.map((page) => [page.slice(0, -'.html'.length), join(root, page)]),
          ),
          output: { chunkFileNames: chunkFileName },
        },
      },
    })) as Rolldown.RolldownOutput
    return output.output.map((file) => file.fileName)
  }

  const page = (script: string) => `<script type="module" src="/${script}"></script>`
  const TOC = { 'src/pages/guide/model/toc.js': "export const TOC = 'Bắt đầu'" }

  it('gates the guide text a page loads lazily, and keeps the entry public', async () => {
    const files = await buildApp({
      'index.html': page('main.js'),
      'main.js': "import('./src/pages/guide/model/toc.js').then((m) => console.log(m.TOC))",
      ...TOC,
    })
    expect(files.filter((f) => f.startsWith(`${GUIDE_CHUNK_DIR}/`))).toHaveLength(1)
    expect(files.filter((f) => f.startsWith('assets/') && f.endsWith('.js'))).toHaveLength(1)
  })

  it('fails when guide text is bundled into the entry', async () => {
    await expect(
      buildApp({
        'index.html': page('main.js'),
        'main.js': "import { TOC } from './src/pages/guide/model/toc.js'; console.log(TOC)",
        ...TOC,
      }),
    ).rejects.toThrow(/reaches the entry "assets\/index-.*\.js" through "assets\/index-/)
  })

  it('fails when an entry statically imports a gated chunk', async () => {
    // Two pages sharing the TOC: the bundler splits it into a chunk of its own, named by
    // `chunkFileNames` and so gated — yet both entries load it before anything else runs.
    await expect(
      buildApp({
        'index.html': page('main.js'),
        'other.html': page('other.js'),
        'main.js': "import { TOC } from './src/pages/guide/model/toc.js'; console.log(TOC)",
        'other.js': "import { TOC } from './src/pages/guide/model/toc.js'; console.warn(TOC)",
        ...TOC,
      }),
    ).rejects.toThrow(new RegExp(`through "${GUIDE_CHUNK_DIR}/`))
  })
})

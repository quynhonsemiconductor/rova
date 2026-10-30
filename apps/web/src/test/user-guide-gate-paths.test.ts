/// <reference types="node" />
/**
 * The User Guide's gated path is spelled in three places that cannot import one another: the SPA
 * that requests the files (`GUIDE_ASSETS_ROOT` in `ui/guide-shot.tsx`), the Pages Function folder
 * that runs the session check (Pages scopes a `_middleware.ts` by its folder), and the gate's own
 * constant (`functions/_lib/guide-gate.ts`, built separately from the SPA). If they drift, the SPA
 * asks for files the gate does not cover — and Pages serves them to anyone. This pins all three.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUIDE_ASSETS_ROOT } from '@/pages/guide/ui/guide-shot'

const WEB = join(import.meta.dirname, '../..')

/** The gate's constant, read from source: the Functions build is not importable from the SPA. */
function gateRoot(): string | undefined {
  const source = readFileSync(join(WEB, 'functions/_lib/guide-gate.ts'), 'utf8')
  return /export const GUIDE_ASSETS_ROOT = '([^']+)'/.exec(source)?.[1]
}

describe('User Guide gated path', () => {
  it('is the same path in the SPA and in the gate', () => {
    expect(gateRoot()).toBe(GUIDE_ASSETS_ROOT)
  })

  it('has a Pages middleware in the folder that serves that path', () => {
    const folder = GUIDE_ASSETS_ROOT.replace(/^\/|\/$/g, '')
    expect(existsSync(join(WEB, 'functions', folder, '_middleware.ts'))).toBe(true)
  })

  it('is served from public/, where the screenshots live', () => {
    expect(existsSync(join(WEB, 'public', GUIDE_ASSETS_ROOT))).toBe(true)
  })
})

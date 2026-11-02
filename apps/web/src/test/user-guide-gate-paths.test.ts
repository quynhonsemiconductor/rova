/**
 * The User Guide's gated path is spelled in several places that cannot import one another: the SPA
 * that requests the files (`GUIDE_ASSETS_ROOT` in `ui/guide-shot.tsx`), the Worker that runs the session
 * check (`GUIDE_ASSETS_ROOT` in `guide-gate.worker.ts`, selected by `run_worker_first` in
 * `wrangler.jsonc`), and the folder the build writes the guide text into. If they drift, the SPA asks
 * for files the gate does not cover and the static handler serves them to anyone. This pins them.
 * (`wrangler-config.contract.test.ts` pins `run_worker_first` itself.)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUIDE_ASSETS_ROOT as GATE_ASSETS_ROOT } from '@/shared/lib/guide-gate.worker'
import { GUIDE_ASSETS_ROOT } from '@/pages/guide/ui/guide-shot'
import { GUIDE_CHUNK_DIR } from '../../vite.config'

const WEB = join(import.meta.dirname, '../..')

describe('User Guide gated path', () => {
  it('is the same path in the SPA and in the gate', () => {
    expect(GATE_ASSETS_ROOT).toBe(GUIDE_ASSETS_ROOT)
  })

  it('is served from public/, where the screenshots live', () => {
    expect(existsSync(join(WEB, 'public', GUIDE_ASSETS_ROOT))).toBe(true)
  })

  it('covers the folder the build writes the guide text into', () => {
    expect(`/${GUIDE_CHUNK_DIR}/`.startsWith(GUIDE_ASSETS_ROOT)).toBe(true)
  })
})

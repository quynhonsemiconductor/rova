/// <reference types="node" />
/**
 * The User Guide's gated path is spelled in places that cannot import one another: the SPA that
 * requests the files (`GUIDE_ASSETS_ROOT` in `ui/guide-shot.tsx`), the Worker gate that runs the
 * session check (`shared/lib/guide-worker-gate.ts`), the `run_worker_first` pattern in
 * `wrangler.jsonc` that decides which requests reach it, and the folder the build writes the guide
 * text into. If they drift, the SPA asks for files the gate does not cover and the static handler
 * serves them to anyone. This pins all of them.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { router } from '@/app/router/router'
import { GUIDE_ASSETS_ROOT } from '@/pages/guide/ui/guide-shot'
import * as workerGate from '@/shared/lib/guide-worker-gate'
import { GUIDE_CHUNK_DIR } from '../../vite.config'

const WEB = join(import.meta.dirname, '../..')

describe('User Guide gated path', () => {
  it('is the same path in the SPA and in the gate', () => {
    expect(workerGate.GUIDE_ASSETS_ROOT).toBe(GUIDE_ASSETS_ROOT)
  })

  it('sends a refused reader back to a path the router opens the guide on', () => {
    expect(router.matchRoutes(workerGate.IN_APP_GUIDE, {}).at(-1)?.routeId).toBe(
      '/auth/user-guide/{-$lang}',
    )
  })

  it('is served from public/, where the screenshots live', () => {
    expect(existsSync(join(WEB, 'public', GUIDE_ASSETS_ROOT))).toBe(true)
  })

  it('covers the folder the build writes the guide text into', () => {
    expect(`/${GUIDE_CHUNK_DIR}/`.startsWith(GUIDE_ASSETS_ROOT)).toBe(true)
  })

  it('is exactly what the Worker runs first for', () => {
    const wrangler = readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8')
    const patterns = /"run_worker_first":\s*(\[[^\]]*\])/.exec(wrangler)?.[1]
    expect(patterns && JSON.parse(patterns)).toEqual([`${GUIDE_ASSETS_ROOT}*`])
  })
})

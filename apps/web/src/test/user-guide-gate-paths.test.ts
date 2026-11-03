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

/**
 * The gate's two facts about the API, pinned to the API. Both had gone stale before this existed: the
 * gate looked for v7's `__Host-rova_session` and asked the retired `/v1/bff/me`, so on develop no reader
 * could load the guide, while the gate's own tests — written with the same two values — all passed.
 */
describe('User Guide gate, against the API', () => {
  it('looks for the session cookie under every name the API issues it', () => {
    // Read from source: `libs/` is the API's code and not part of the SPA's build.
    const source = readFileSync(join(WEB, '../../libs/platform/src/auth/session-cookie.ts'), 'utf8')
    const product = /export const IDENTITY_PRODUCT = '([^']+)'/.exec(source)?.[1]
    const name =
      /export const SESSION_COOKIE = `\$\{HOST_COOKIES \? '([^']+)' : '([^']+)'\}\$\{IDENTITY_PRODUCT\}([^`]*)`/.exec(
        source,
      )
    expect(product, 'IDENTITY_PRODUCT moved: update this test and the gate').toBeDefined()
    expect(name, 'SESSION_COOKIE changed shape: update this test and the gate').not.toBeNull()
    const [, hostPrefix, securePrefix, suffix] = name!
    expect([...workerGate.SESSION_COOKIES].sort()).toEqual(
      [`${hostPrefix}${product}${suffix}`, `${securePrefix}${product}${suffix}`].sort(),
    )
  })

  it('asks the same "who am I?" as the SPA, and the API serves it', () => {
    const bootstrap = readFileSync(join(WEB, 'src/shared/api/auth-bootstrap.ts'), 'utf8')
    expect(bootstrap).toContain(`\${BASE}${workerGate.SESSION_CHECK_PATH}\``)
    // The generated client is the API's OpenAPI document, committed: a removed route leaves it.
    const client = readFileSync(join(WEB, 'src/shared/api/generated/api.ts'), 'utf8')
    expect(client).toContain(`'${workerGate.SESSION_CHECK_PATH}': {`)
  })
})

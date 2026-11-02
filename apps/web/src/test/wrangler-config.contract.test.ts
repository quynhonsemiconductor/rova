/**
 * The on-prem edge contract (ONPREM-PLAN §8.2) — `apps/web/wrangler.jsonc` is half of it, and the
 * other half lives in another repo (`infra` `live/edge/onprem.tf`), so nothing else can catch drift.
 *
 * Each assertion protects a decision that fails SILENTLY when reversed:
 *
 * - the script names must be `<product>-<env>-web` — Terraform's `cloudflare_workers_route.spa`
 *   names its script that way, and a rename deploys a Worker no route points at (or, worse, leaves
 *   the routed name serving an old bundle forever);
 * - no `routes` in the config: `live/edge` owns routes and the deploy token is Workers Scripts:
 *   edit only. A route here either races Terraform or makes the deploy fail on a permission the
 *   token deliberately does not have;
 * - `workers_dev` / `preview_urls` off, at the TOP level and inside every environment (Wrangler does
 *   not inherit these), so the bundle has exactly one address: the host Access protects;
 * - SPA fallback and trailing-slash HTML handling, because every app route is client-side and the
 *   User Guide links pages without `.html` (Pages stripped it; Workers must keep doing so).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** `wrangler.jsonc` is JSON + line comments; none of ours contain `//` inside a string value. */
function readConfig(): Record<string, unknown> {
  const raw = readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8')
  const json = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  return JSON.parse(json) as Record<string, unknown>
}

const config = readConfig()
const envs = config.env as Record<string, Record<string, unknown>>

describe('the Workers Static Assets config', () => {
  it('names the two scripts Terraform routes to', () => {
    expect(envs.dev!.name).toBe('rova-dev-web')
    expect(envs.prod!.name).toBe('rova-prod-web')
  })

  it('declares no routes — live/edge owns them', () => {
    expect(config).not.toHaveProperty('routes')
    expect(config).not.toHaveProperty('route')
    for (const env of Object.values(envs)) {
      expect(env).not.toHaveProperty('routes')
      expect(env).not.toHaveProperty('route')
    }
  })

  it('turns workers.dev and preview URLs off everywhere, including each environment', () => {
    expect(config.workers_dev).toBe(false)
    expect(config.preview_urls).toBe(false)
    for (const env of Object.values(envs)) {
      expect(env.workers_dev).toBe(false)
      expect(env.preview_urls).toBe(false)
    }
  })

  it('wires the US-119 guide gate as a Worker that runs only for /guide/* and /guide-assets/*', () => {
    // Workers Static Assets never run the Pages Function in apps/web/functions, so the gate that
    // keeps the guide private is this entry. `run_worker_first` is what keeps every other path on
    // the static fast path; `binding` is the handle the entry serves files through.
    expect(config.main).toBe('src/shared/lib/guide-gate.worker.ts')
    const assets = config.assets as Record<string, unknown>
    expect(assets.binding).toBe('ASSETS')
    // `/guide-assets/*` holds screenshots of production data: it must be gated like the guide.
    expect(assets.run_worker_first).toEqual(['/guide/*', '/guide-assets/*'])
  })

  it('serves the built SPA with client-side routing and extensionless guide pages', () => {
    const assets = config.assets as Record<string, unknown>
    expect(assets.directory).toBe('./dist')
    expect(assets.not_found_handling).toBe('single-page-application')
    expect(assets.html_handling).toBe('auto-trailing-slash')
  })
})

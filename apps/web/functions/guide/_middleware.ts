/**
 * Cloudflare Pages Function: admit only signed-in readers to the User Guide (US-119).
 *
 * A `_middleware.ts` under `functions/guide/` runs for `/guide/*` ONLY — the same path-scoping
 * `functions/v1/[[path]].ts` uses, so the SPA's own static assets stay on Cloudflare's fast path.
 * The decision itself lives in `_lib/guide-gate.ts`.
 */
import { guardGuide } from '../_lib/guide-gate'

interface Env {
  API_ORIGIN?: string
}

type PagesFunction = (context: {
  request: Request
  env: Env
  next: () => Promise<Response>
}) => Promise<Response>

export const onRequest: PagesFunction = (context) =>
  guardGuide(context.request, context.env.API_ORIGIN, context.next)

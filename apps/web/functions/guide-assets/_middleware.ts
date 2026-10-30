/**
 * Cloudflare Pages Function: admit only signed-in readers to the in-app User Guide's screenshots.
 *
 * Runs for `/guide-assets/*` ONLY, like `functions/guide/_middleware.ts` does for the static guide, so
 * the SPA's own assets stay on Cloudflare's fast path. The guide's text ships in the SPA bundle; the
 * screenshots show production data, so they are the part still gated. Same decision, same env
 * (`API_ORIGIN`, `EDGE_CLIENT_IP_SECRET`): `_lib/guide-gate.ts`.
 */
import { guardGuide } from '../_lib/guide-gate'
import type { ProxyEnv } from '../_lib/proxy'

type PagesFunction = (context: {
  request: Request
  env: ProxyEnv
  next: () => Promise<Response>
}) => Promise<Response>

export const onRequest: PagesFunction = (context) =>
  guardGuide(context.request, context.env, context.next)

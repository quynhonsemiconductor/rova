/**
 * Cloudflare Pages Function: admit only signed-in readers to the User Guide (US-119).
 *
 * A `_middleware.ts` under `functions/guide/` runs for `/guide/*` ONLY — the same path-scoping
 * `functions/v1/[[path]].ts` uses, so the SPA's own static assets stay on Cloudflare's fast path.
 * The decision itself lives in `_lib/guide-gate.ts`. Needs the same `API_ORIGIN` and
 * `EDGE_CLIENT_IP_SECRET` as the `/v1/*` proxy.
 */
export { guideMiddleware as onRequest } from '../_lib/guide-gate'

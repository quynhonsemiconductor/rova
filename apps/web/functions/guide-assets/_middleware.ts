/**
 * Cloudflare Pages Function: admit only signed-in readers to the in-app User Guide's files — its
 * screenshots, and under `js/` the build chunks that carry its text (`chunkFileName` in
 * `vite.config.ts`).
 *
 * Runs for `/guide-assets/*` ONLY — path-scoped like `functions/v1/[[path]].ts` — so the rest of the
 * SPA stays on Cloudflare's fast path. Same decision, same env (`API_ORIGIN`,
 * `EDGE_CLIENT_IP_SECRET`): `_lib/guide-gate.ts`.
 */
export { guideMiddleware as onRequest } from '../_lib/guide-gate'

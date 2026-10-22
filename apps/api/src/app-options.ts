import type { HttpAppOptions } from '@quynhonsemiconductor/platform-runtime/bootstrap';

/**
 * The API's bootstrap options, in ONE place: `main.ts` starts the process with them and the logging conformance spec boots the same object, so
 * what is tested is what ships (a spec that re-typed these would keep passing after `main.ts` changed).
 *
 * Import discipline: this file imports only a TYPE at the top. The product modules are imported inside the functions, after OpenTelemetry is
 * installed, which is the whole point of `module` being a function.
 */
// Trimmed 2026-10-21 from the 20-entry list (the OTel defaults plus extensions) to stay under
// Grafana Cloud's free-tier series cap: every boundary is one `_bucket` series per
// route x method x status class x instance, and http_server_duration was ~50% of the whole
// bill. Kept, deliberately: 1_000 and 2_500 (the slow_request_bucket_ms values the infra
// precondition and the http-slow-request-count rule select on), 10_000 (the old p99 clamp)
// and 180_000 (a 12-second request must stay separable from a spent retry budget).
const HTTP_DURATION_BOUNDARIES_MS = [0, 250, 1_000, 2_500, 5_000, 10_000, 60_000, 180_000];

export const apiAppOptions: HttpAppOptions = {
  module: () => import('./app.module').then((m) => m.AppModule),
  otel: { defaultServiceName: 'rova-api', httpDurationBoundaries: HTTP_DURATION_BOUNDARIES_MS },
  http: { rawBody: true },
  configure: async (app) => {
    const { bootstrapApp } = await import('./bootstrap/app.bootstrap');
    await bootstrapApp(app);
  },
};

import type { HttpAppOptions } from '@quynhonsemiconductor/platform-runtime/bootstrap';

/**
 * The API's bootstrap options, in ONE place: `main.ts` starts the process with them and the logging conformance spec boots the same object, so
 * what is tested is what ships (a spec that re-typed these would keep passing after `main.ts` changed).
 *
 * Import discipline: this file imports only a TYPE at the top. The product modules are imported inside the functions, after OpenTelemetry is
 * installed, which is the whole point of `module` being a function.
 */
const HTTP_DURATION_BOUNDARIES_MS = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 30_000,
  60_000, 120_000, 180_000,
];

export const apiAppOptions: HttpAppOptions = {
  module: () => import('./app.module').then((m) => m.AppModule),
  otel: { defaultServiceName: 'rova-api', httpDurationBoundaries: HTTP_DURATION_BOUNDARIES_MS },
  http: { rawBody: true },
  configure: async (app) => {
    const { bootstrapApp } = await import('./bootstrap/app.bootstrap');
    await bootstrapApp(app);
  },
};

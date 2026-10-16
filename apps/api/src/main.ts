import { createHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';

// The whole bootstrap lives in the shared library: `.env`, OpenTelemetry, the pino logger (JSON from the first line), graceful
// shutdown, the fatal handler. `module` is a function so OpenTelemetry is installed BEFORE pg/http/ioredis are loaded.
// This product supplies only what is its own: the route-duration buckets and `bootstrapApp` (helmet, CSP, swagger, prefix).
const HTTP_DURATION_BOUNDARIES_MS = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 30_000,
  60_000, 120_000, 180_000,
];

void createHttpApp({
  module: () => import('./app.module').then((m) => m.AppModule),
  otel: { defaultServiceName: 'rova-api', httpDurationBoundaries: HTTP_DURATION_BOUNDARIES_MS },
  http: { rawBody: true },
  configure: async (app) => {
    const { bootstrapApp } = await import('./bootstrap/app.bootstrap');
    await bootstrapApp(app);
  },
});

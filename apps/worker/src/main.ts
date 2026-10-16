import { createWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';

// The whole bootstrap lives in the shared library (see apps/api/src/main.ts): `.env`, OpenTelemetry, the pino logger, graceful shutdown,
// the fatal handler. The worker has no HTTP server, so there is no readiness flip or drain.
void createWorkerApp({
  module: () => import('./worker.module').then((m) => m.WorkerModule),
  otel: { defaultServiceName: 'rova-worker' },
});

import { createWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { workerAppOptions } from './worker-options';

// The whole bootstrap lives in the shared library (see apps/api/src/main.ts): `.env`, OpenTelemetry, the pino logger, graceful shutdown,
// the fatal handler. The worker has no HTTP server, so there is no readiness flip or drain. Its options are in `worker-options.ts`.
void createWorkerApp(workerAppOptions);

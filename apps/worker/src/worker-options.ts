import type { WorkerAppOptions } from '@quynhonsemiconductor/platform-runtime/bootstrap';

/**
 * The worker's bootstrap options, in ONE place: `main.ts` starts the process with them and the logging conformance spec boots the same object,
 * so what is tested is what ships. Only a TYPE is imported at the top; the worker module is imported lazily, after OpenTelemetry.
 */
export const workerAppOptions: WorkerAppOptions = {
  module: () => import('./worker.module').then((m) => m.WorkerModule),
  otel: {
    // The api and the worker share one `.env` locally, and `.env` names the API (`OTEL_SERVICE_NAME=rova-api`). The worker is named by its own
    // variable so it does not report itself as the api, in spans AND in logs: the bootstrap gives both the same answer. Deployed, the task sets
    // both variables to `rova-worker`.
    serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
    defaultServiceName: 'rova-worker',
  },
};

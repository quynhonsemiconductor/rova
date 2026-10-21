/**
 * Logging conformance: the REAL api and worker, booted through the shared bootstrap, write the log contract on EVERY line.
 *
 * Why this exists: the worker once built the pino logger and never installed it, so Nest wrote `[Nest] 7 - ... LOG [Shutdown]` text and the
 * log pipeline failed to parse 100% of its lines. No unit test sees that; only booting the real module and reading what it prints does.
 *
 * `runLoggingConformance` captures what the process writes from boot to close and asserts every captured line is a JSON object with
 * `level` (a label), `time` (ISO-8601), `msg`, `service`, `env` (the DEPLOYMENT env), `version`, that nothing is `[Nest]` text, and that a
 * credential in an SDK-style error is `[REDACTED]`. Needs the dev Postgres and Valkey like every spec here.
 */
import 'reflect-metadata';
import { describe, it } from 'vitest';
import { prepareHttpApp, prepareWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { runLoggingConformance } from '@quynhonsemiconductor/observability/testing';
import { apiAppOptions } from '../../apps/api/src/app-options';
import { workerAppOptions } from '../../apps/worker/src/worker-options';

const ENV = {
  ...process.env,
  NODE_ENV: 'production', // pinned to production in every deployed environment, on purpose
  DEPLOYMENT_ENV: 'develop',
  SERVICE_VERSION: 'sha-conformance',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
} as NodeJS.ProcessEnv;

describe('logging conformance (real modules, shared bootstrap)', () => {
  it('rova-api: every line from boot to close is the log contract', async () => {
    await runLoggingConformance({
      expected: { service: 'rova-api', env: 'develop', version: 'sha-conformance' },
      boot: async (logStream) => {
        // The SAME options object main.ts starts the process with; only the environment and the log sink are the test's.
        const app = await prepareHttpApp({
          ...apiAppOptions,
          env: { ...ENV, OTEL_SERVICE_NAME: 'rova-api' },
          logStream,
        });
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        return {
          app,
          request: async () => {
            await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/livez' });
            await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/nope' });
          },
        };
      },
    });
  });

  it('rova-worker: every line from boot to close is the log contract', async () => {
    await runLoggingConformance({
      expected: { service: 'rova-worker', env: 'develop', version: 'sha-conformance' },
      boot: async (logStream) => ({
        // The SAME options object main.ts starts the process with. The environment is the local one that caused the bug this guards: `.env`
        // names the API for the whole checkout, and the worker must still say `rova-worker`.
        app: await prepareWorkerApp({
          ...workerAppOptions,
          env: { ...ENV, OTEL_SERVICE_NAME: 'rova-api', OTEL_WORKER_SERVICE_NAME: 'rova-worker' },
          logStream,
        }),
      }),
    });
  });
});

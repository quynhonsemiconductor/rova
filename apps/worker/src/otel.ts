/**
 * OpenTelemetry bootstrap for the worker — must be the very first import in
 * worker/main.ts, so auto-instrumentation patches pg, ioredis and the AWS SDK
 * before any module loads them.
 *
 * Shares the implementation with the API; see
 * the `@quynhonsemiconductor/observability` package. Imported from its `/otel` subpath rather
 * than the package root on purpose: the root barrel reaches Nest and pino, which
 * would then be required *before* instrumentation is installed.
 *
 * Reads `OTEL_WORKER_SERVICE_NAME` so the two processes stay distinguishable in the
 * backend even when they share a task definition's environment.
 *
 * Shutdown: `enableGracefulShutdown()` (platform-runtime, called from worker/main.ts) flushes
 * OpenTelemetry after `app.close()`.
 *
 * NO `httpDurationBoundaries` HERE, unlike `apps/api/src/otel.ts`, and that is a
 * finding rather than an omission. The worker records no inbound HTTP at all: it
 * boots through `NestFactory.createApplicationContext` (worker/main.ts), so there is
 * no HTTP adapter and no listening socket; `HttpLoggingInterceptor` — the only thing
 * in this codebase that records `http.server.duration` — is registered as an
 * APP_INTERCEPTOR in `apps/api/src/app.module.ts` and nowhere else; and
 * `WorkerModule` registers no controllers-with-adapter path that could reach it. The
 * option installs a View on the `http.server.duration` instrument specifically, so
 * passing it here would create a metric view for an instrument this process never
 * records — a config line whose only effect is to look like coverage. Outbound calls
 * the worker DOES make (Graph, SES, R2, GitHub) land on `http.client.duration`, which
 * this option does not touch; if that histogram's tail becomes interesting it needs
 * its own option in the package rather than this one being widened to match on name.
 */
import { startOtel } from '@quynhonsemiconductor/observability/otel';

startOtel({
  defaultServiceName: 'rally-worker',
  serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
});

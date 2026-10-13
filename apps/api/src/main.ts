// `.env` FIRST, above the OTel bootstrap: that bootstrap reads process.env directly, and
// @nestjs/config does not load the file until ConfigModule initialises — far too late.
// See @quynhonsemiconductor/platform-runtime's own header: this MUST stay above the
// OTel bootstrap, and MUST come from the subpath rather than the package root.
import '@quynhonsemiconductor/platform-runtime/load-env';
// OTel must be bootstrapped BEFORE any other imports so auto-instrumentation patches modules
import './otel';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { enableGracefulShutdown } from '@quynhonsemiconductor/platform-runtime';
import { AppModule } from './app.module';
import { bootstrapApp } from './bootstrap/app.bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Disable Fastify's built-in logger — pino handles all logging
      logger: false,
      // Trust X-Forwarded-For from ALB
      trustProxy: true,
    }),
    // rawBody: preserve the exact request bytes on req.rawBody so the SCM
    // webhook controller can verify GitHub's X-Hub-Signature-256 HMAC.
    { bufferLogs: true, rawBody: true },
  );

  await bootstrapApp(app);

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  // Leave the Service cleanly on SIGTERM / SIGINT: /readyz answers 503, the server keeps serving for the
  // endpoint-removal delay (SHUTDOWN_ENDPOINT_DELAY_MS: 5 s in a Kubernetes pod, 0 elsewhere), stops listening and
  // drains in-flight requests, then app.close() runs the destroy hooks (DB pool, Valkey) and OpenTelemetry is
  // flushed. Bounded by SHUTDOWN_TIMEOUT_MS (25 s, inside ECS's 30 s stopTimeout and a pod's 30 s grace period).
  // Replaces this file's own SIGTERM/SIGINT handlers; it must be called before listen().
  enableGracefulShutdown(app);

  await app.listen(port, host);

  const logger = app.get(Logger);
  logger.log(`🚀 API listening on ${host}:${port} [${process.env['NODE_ENV']}]`, 'Bootstrap');

  // Log unhandled rejections without crashing (they surface via normal paths)
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ msg: 'Unhandled promise rejection', reason }, 'Bootstrap');
  });

  // Uncaught exceptions leave process in unknown state — log then exit
  process.on('uncaughtException', (error: Error) => {
    logger.error({ msg: 'Uncaught exception', error }, 'Bootstrap');
    process.exit(1);
  });
}

void bootstrap();

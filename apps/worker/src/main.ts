// `.env` FIRST, above the OTel bootstrap: that bootstrap reads process.env directly, and
// @nestjs/config does not load the file until ConfigModule initialises — far too late.
// See @quynhonsemiconductor/platform-runtime's own header: this MUST stay above the
// OTel bootstrap, and MUST come from the subpath rather than the package root.
import '@quynhonsemiconductor/platform-runtime/load-env';
// OTel must be bootstrapped BEFORE any other imports so auto-instrumentation patches modules
import './otel';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { enableGracefulShutdown } from '@quynhonsemiconductor/platform-runtime';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // createApplicationContext: no HTTP driver needed — worker is queue/cron only
  const app = await NestFactory.createApplicationContext(WorkerModule);

  const logger = app.get(Logger);
  logger.log('Worker process started', 'Bootstrap');

  // SIGTERM / SIGINT: stop the crons and relays (Nest's beforeApplicationShutdown), release the pool, flush
  // OpenTelemetry, exit. No HTTP server here, so the readiness flip and the drain are skipped. A relay pass that is
  // mid-call finishes its row or its lease lapses and another worker takes it (lease-and-fence).
  enableGracefulShutdown(app);

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ msg: 'Unhandled promise rejection', reason }, 'Bootstrap');
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error({ msg: 'Uncaught exception', error }, 'Bootstrap');
    process.exit(1);
  });
}

void bootstrap();

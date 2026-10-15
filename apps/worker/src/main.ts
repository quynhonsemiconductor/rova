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
  // createApplicationContext: no HTTP driver needed — worker is queue/cron only.
  //
  // `bufferLogs` + `useLogger`, exactly as the API does. Without them Nest's own default text logger stayed installed: every framework line and every
  // `new Logger('Shutdown')` line (including platform-runtime's) was written as `[Nest] 7 - ... LOG [Shutdown] ...`, which is not JSON, so the log pipeline
  // failed to parse 100% of the worker's lines and none of them carried env, version or trace.id. The pino Logger had been built (LoggerModule) but never
  // INSTALLED. `bufferLogs` holds the early lines until it is, so the bootstrap lines are JSON too.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const logger = app.get(Logger);
  logger.log('Worker process started', 'Bootstrap');

  // SIGTERM / SIGINT, in Nest's close order: `onModuleDestroy` runs first (the relays unsubscribe their Valkey wake
  // signals), then `beforeApplicationShutdown` (ScheduleModule stops every cron, so no NEW relay pass starts), then
  // `onApplicationShutdown` (the pool and cache close), then OpenTelemetry is flushed. There is no HTTP server here,
  // so the readiness flip and the drain are skipped. Nothing WAITS for a relay pass that is already running: its next
  // database write fails once the pool is closed, and the row's lease lapses and another worker takes it
  // (lease-and-fence), so a deploy never strands a row.
  enableGracefulShutdown(app);

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ msg: 'Unhandled promise rejection', reason }, 'Bootstrap');
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error({ msg: 'Uncaught exception', error }, 'Bootstrap');
    process.exit(1);
  });
}

bootstrap().catch((error: unknown) => {
  // With bufferLogs the pino logger may not be installed yet, so this goes to stderr directly.
  // eslint-disable-next-line no-console
  console.error('Fatal worker bootstrap error', error);
  process.exit(1);
});

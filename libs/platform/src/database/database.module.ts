import { Global, Module } from '@nestjs/common';
import { DATABASE_POOL_TOKEN, DRIZZLE, DrizzleProvider } from './drizzle.provider';
import { UNIT_OF_WORK, UnitOfWork } from './unit-of-work';
import { DbPoolMetrics } from '@quynhonsemiconductor/observability';

@Global()
@Module({
  providers: [
    // DbPoolMetrics is provided here, not only in PlatformModule: DrizzleProvider
    // injects it, and DatabaseModule must be able to construct on its own.
    DbPoolMetrics,
    DrizzleProvider,
    { provide: DRIZZLE, useFactory: (p: DrizzleProvider) => p.instance, inject: [DrizzleProvider] },
    // For `enableHealth()`'s built-in database check. See DATABASE_POOL_TOKEN for why it must exist.
    {
      provide: DATABASE_POOL_TOKEN,
      useFactory: (p: DrizzleProvider) => p.poolHandle,
      inject: [DrizzleProvider],
    },
    { provide: UNIT_OF_WORK, useClass: UnitOfWork },
    UnitOfWork,
  ],
  exports: [DRIZZLE, DATABASE_POOL_TOKEN, UNIT_OF_WORK, UnitOfWork, DrizzleProvider],
})
export class DatabaseModule {}

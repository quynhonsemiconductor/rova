import { Module } from '@nestjs/common';
import { ProjectsModule } from '@modules/projects';
import { AccessModule } from '@modules/access';
import { AttachmentsModule } from '@modules/attachments';
import { ActivityModule } from '@modules/activity';
// The milestone-artifact scope rule lives with the milestones module — both write paths into
// `milestone_artifacts` go through it. Safe to import: MilestonesModule does not import this one.
import { MilestonesModule } from '@modules/milestones';
import { WorkItemsService } from './application/work-items.service';
import { WorkItemsController } from './interface/http/work-items.controller';
import { WorkItemDrizzleRepository } from './infrastructure/persistence/work-item.drizzle-repository';
import { TimeLogDrizzleRepository } from './infrastructure/persistence/time-log.drizzle-repository';
import { WatcherDrizzleRepository } from './infrastructure/persistence/watcher.drizzle-repository';
import { WorkItemRelationDrizzleRepository } from './infrastructure/persistence/work-item-relation.drizzle-repository';
import { WORK_ITEM_REPOSITORY } from './domain/ports/work-item.repository';
import { WORK_ITEM_RELATION_REPOSITORY } from './domain/ports/work-item-relation.repository';
import { TIME_LOG_REPOSITORY } from './domain/ports/time-log.repository';
import { WATCHER_REPOSITORY } from './domain/ports/watcher.repository';
// Repo-level only (F1/F4's Test Case cascade) — NOT `TestCasesModule`, which imports
// `WorkItemsModule` itself; importing it back here would be a genuine NestJS module cycle. The
// Drizzle repo classes have no dependency on this module, so providing them directly is safe.
import { TestCaseDrizzleRepository } from '@modules/test-cases/infrastructure/persistence/test-case.drizzle-repository';
import { TestResultDrizzleRepository } from '@modules/test-cases/infrastructure/persistence/test-result.drizzle-repository';
import { TEST_CASE_REPOSITORY } from '@modules/test-cases/domain/ports/test-case.repository';
import { TEST_RESULT_REPOSITORY } from '@modules/test-cases/domain/ports/test-result.repository';

@Module({
  imports: [ProjectsModule, AccessModule, AttachmentsModule, ActivityModule, MilestonesModule],
  controllers: [WorkItemsController],
  providers: [
    WorkItemsService,
    // StorageService is provided globally by PlatformModule — no need to re-register here.
    { provide: WORK_ITEM_REPOSITORY, useClass: WorkItemDrizzleRepository },
    { provide: TIME_LOG_REPOSITORY, useClass: TimeLogDrizzleRepository },
    { provide: WATCHER_REPOSITORY, useClass: WatcherDrizzleRepository },
    { provide: WORK_ITEM_RELATION_REPOSITORY, useClass: WorkItemRelationDrizzleRepository },
    { provide: TEST_CASE_REPOSITORY, useClass: TestCaseDrizzleRepository },
    { provide: TEST_RESULT_REPOSITORY, useClass: TestResultDrizzleRepository },
  ],
  exports: [WorkItemsService],
})
export class WorkItemsModule {}

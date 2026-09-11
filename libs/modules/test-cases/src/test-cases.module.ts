import { Module } from '@nestjs/common';
import { AccessModule } from '@modules/access';
import { WorkItemsModule } from '@modules/work-items';
import { ProjectsModule } from '@modules/projects';
import { ActivityModule } from '@modules/activity';
import { AttachmentsModule } from '@modules/attachments';
import { TestCasesService } from './application/test-cases.service';
import { TestResultsService } from './application/test-results.service';
import { WorkItemTestCasesController } from './interface/http/test-cases.controller';
import { TestCaseRecordsController } from './interface/http/test-case-records.controller';
import { TestResultRecordsController } from './interface/http/test-result-records.controller';
import { TestCaseTypesController } from './interface/http/test-case-types.controller';
import { TestCaseDrizzleRepository } from './infrastructure/persistence/test-case.drizzle-repository';
import { TestResultDrizzleRepository } from './infrastructure/persistence/test-result.drizzle-repository';
import { TEST_CASE_REPOSITORY } from './domain/ports/test-case.repository';
import { TEST_RESULT_REPOSITORY } from './domain/ports/test-result.repository';

@Module({
  imports: [AccessModule, WorkItemsModule, ProjectsModule, ActivityModule, AttachmentsModule],
  controllers: [
    WorkItemTestCasesController,
    TestCaseRecordsController,
    TestResultRecordsController,
    TestCaseTypesController,
  ],
  providers: [
    TestCasesService,
    TestResultsService,
    { provide: TEST_CASE_REPOSITORY, useClass: TestCaseDrizzleRepository },
    { provide: TEST_RESULT_REPOSITORY, useClass: TestResultDrizzleRepository },
  ],
  exports: [TestCasesService, TestResultsService],
})
export class TestCasesModule {}

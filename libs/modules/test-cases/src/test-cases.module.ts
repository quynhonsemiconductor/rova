import { Module } from '@nestjs/common';
import { AccessModule } from '@modules/access';
import { WorkItemsModule } from '@modules/work-items';
import { ProjectsModule } from '@modules/projects';
import { ActivityModule } from '@modules/activity';
import { AttachmentsModule } from '@modules/attachments';
import { TestCasesService } from './application/test-cases.service';
import { TestResultsService } from './application/test-results.service';
import { TestCaseTypesService } from './application/test-case-types.service';
import { WorkItemTestCasesController } from './interface/http/test-cases.controller';
import { TestCaseRecordsController } from './interface/http/test-case-records.controller';
import { TestResultRecordsController } from './interface/http/test-result-records.controller';
import { TestCaseTypesController } from './interface/http/test-case-types.controller';
import { TestCaseDrizzleRepository } from './infrastructure/persistence/test-case.drizzle-repository';
import { TestResultDrizzleRepository } from './infrastructure/persistence/test-result.drizzle-repository';
import { TestCaseTypeDrizzleRepository } from './infrastructure/persistence/test-case-type.drizzle-repository';
import { TEST_CASE_REPOSITORY } from './domain/ports/test-case.repository';
import { TEST_RESULT_REPOSITORY } from './domain/ports/test-result.repository';
import { TEST_CASE_TYPE_REPOSITORY } from './domain/ports/test-case-type.repository';

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
    TestCaseTypesService,
    { provide: TEST_CASE_REPOSITORY, useClass: TestCaseDrizzleRepository },
    { provide: TEST_RESULT_REPOSITORY, useClass: TestResultDrizzleRepository },
    { provide: TEST_CASE_TYPE_REPOSITORY, useClass: TestCaseTypeDrizzleRepository },
  ],
  exports: [TestCasesService, TestResultsService, TestCaseTypesService],
})
export class TestCasesModule {}

import { Module } from '@nestjs/common';
import { AccessModule } from '@modules/access';
import { WorkItemsModule } from '@modules/work-items';
import { ProjectsModule } from '@modules/projects';
import { ActivityModule } from '@modules/activity';
import { TestCasesService } from './application/test-cases.service';
import { WorkItemTestCasesController } from './interface/http/test-cases.controller';
import { TestCaseRecordsController } from './interface/http/test-case-records.controller';
import { TestCaseTypesController } from './interface/http/test-case-types.controller';
import { TestCaseDrizzleRepository } from './infrastructure/persistence/test-case.drizzle-repository';
import { TEST_CASE_REPOSITORY } from './domain/ports/test-case.repository';

@Module({
  imports: [AccessModule, WorkItemsModule, ProjectsModule, ActivityModule],
  controllers: [WorkItemTestCasesController, TestCaseRecordsController, TestCaseTypesController],
  providers: [
    TestCasesService,
    { provide: TEST_CASE_REPOSITORY, useClass: TestCaseDrizzleRepository },
  ],
  exports: [TestCasesService],
})
export class TestCasesModule {}

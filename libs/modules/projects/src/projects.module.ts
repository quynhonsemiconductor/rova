import { Module } from '@nestjs/common';
import { ProjectsService } from './application/projects.service';
import { ProjectsController } from './interface/http/projects.controller';
import { ProjectDrizzleRepository } from './infrastructure/persistence/project.drizzle-repository';
import { WorkflowStatusDrizzleRepository } from './infrastructure/persistence/workflow-status.drizzle-repository';
import { LabelDrizzleRepository } from './infrastructure/persistence/label.drizzle-repository';
import { ProjectTeamDrizzleRepository } from './infrastructure/persistence/project-team.drizzle-repository';
import { ProjectMemberDrizzleRepository } from './infrastructure/persistence/project-member.drizzle-repository';
import { PROJECT_REPOSITORY } from './domain/ports/project.repository';
import { WORKFLOW_STATUS_REPOSITORY } from './domain/ports/workflow-status.repository';
import { LABEL_REPOSITORY } from './domain/ports/label.repository';
import { PROJECT_TEAM_REPOSITORY } from './domain/ports/project-team.repository';
import { PROJECT_MEMBER_REPOSITORY } from './domain/ports/project-member.repository';
import { WorkspaceModule } from '@modules/workspace';
import { AccessModule } from '@modules/access';
import { ActivityModule } from '@modules/activity';
// Deep-import, never `TestCasesService` — `TestCasesModule` already imports `ProjectsModule`
// (it needs `ProjectsService.assertAssignable` for Owner/Assigned To), so a service-level
// dependency the other way would close a cycle. G3 only ever needs one write
// (`ITestCaseTypeRepository.create`), which the repository port already expresses — the same
// repo-level-only shape F1 established for `WorkItemsModule`/`TestCasesService`.
import { TestCaseTypeDrizzleRepository } from '@modules/test-cases/infrastructure/persistence/test-case-type.drizzle-repository';
import { TEST_CASE_TYPE_REPOSITORY } from '@modules/test-cases/domain/ports/test-case-type.repository';

@Module({
  imports: [WorkspaceModule, AccessModule, ActivityModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    { provide: PROJECT_REPOSITORY, useClass: ProjectDrizzleRepository },
    { provide: WORKFLOW_STATUS_REPOSITORY, useClass: WorkflowStatusDrizzleRepository },
    { provide: LABEL_REPOSITORY, useClass: LabelDrizzleRepository },
    { provide: PROJECT_TEAM_REPOSITORY, useClass: ProjectTeamDrizzleRepository },
    { provide: PROJECT_MEMBER_REPOSITORY, useClass: ProjectMemberDrizzleRepository },
    { provide: TEST_CASE_TYPE_REPOSITORY, useClass: TestCaseTypeDrizzleRepository },
  ],
  exports: [ProjectsService, WORKFLOW_STATUS_REPOSITORY, LABEL_REPOSITORY],
})
export class ProjectsModule {}

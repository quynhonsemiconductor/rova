import { Module } from '@nestjs/common';
import { WorkItemsModule } from '@modules/work-items';
import { AccessModule } from '@modules/access';
import { ProjectsModule } from '@modules/projects';
import { CollaborationService } from './application/collaboration.service';
import { CollaborationController } from './interface/http/collaboration.controller';
import { CommentDrizzleRepository } from './infrastructure/persistence/comment.drizzle-repository';
import { COMMENT_REPOSITORY } from './domain/ports/comment.repository';
import { PortfolioModule } from '@modules/portfolio';
import { ActivityModule } from '@modules/activity';
import { PortfolioCollaborationController } from './interface/http/portfolio-collaboration.controller';

@Module({
  // ProjectsModule for `assertProjectWritable` alone (PRJ-FR-010) — a direct import because Nest
  // does not inject a provider reached only transitively through PortfolioModule.
  imports: [WorkItemsModule, AccessModule, PortfolioModule, ProjectsModule, ActivityModule],
  controllers: [CollaborationController, PortfolioCollaborationController],
  providers: [
    CollaborationService,
    { provide: COMMENT_REPOSITORY, useClass: CommentDrizzleRepository },
  ],
  exports: [CollaborationService],
})
export class CollaborationModule {}

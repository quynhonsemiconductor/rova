import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { teamStatusEnum } from '../../../../../../../db/schema/enums';

/**
 * The TEAM response shapes of `GET /workspaces/:workspaceId/teams` (and `GET /teams/:id`),
 * produced by `toTeamDto` / `toTeamWithStatsDto` in team.controller.ts.
 *
 * The controller maps plain objects rather than a zod DTO, so this schema is the contract's
 * written form: the MCP tool's fixture parses through it, and a renamed or removed producer
 * field breaks that test instead of silently reaching an agent.
 */
export const TeamResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  leadId: z.string().uuid().nullable(),
  status: z.enum(teamStatusEnum.enumValues),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class TeamResponseDto extends createZodDto(TeamResponseSchema) {}

/** A project the team is actively linked to (`toTeamDto` passes the repository's links through). */
export const TeamProjectLinkSchema = z.object({
  projectId: z.string().uuid(),
  key: z.string(),
  name: z.string(),
});

/** The list row: the team plus its active-link count and links. */
export const TeamWithStatsResponseSchema = TeamResponseSchema.extend({
  memberCount: z.number().int().min(0),
  projects: z.array(TeamProjectLinkSchema),
});

export class TeamWithStatsResponseDto extends createZodDto(TeamWithStatsResponseSchema) {}

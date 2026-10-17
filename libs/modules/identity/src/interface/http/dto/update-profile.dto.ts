import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateProfileSchema = z.object({
  displayName: z.string().min(1).max(255).trim().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(100).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
});

export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}

export const SwitchWorkspaceSchema = z.object({
  workspaceId: z.string().uuid('workspaceId must be a valid UUID'),
});

export class SwitchWorkspaceDto extends createZodDto(SwitchWorkspaceSchema) {}

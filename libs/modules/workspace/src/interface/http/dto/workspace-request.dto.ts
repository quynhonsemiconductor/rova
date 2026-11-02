import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PROJECT_ACCESS_LEVEL } from '@shared-kernel';
import { workspaceMemberStatusEnum } from '../../../../../../../db/schema/enums';

// ── Create Workspace ─────────────────────────────────────────────────────────

export const CreateWorkspaceSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(255).trim(),
  description: z.string().max(1000).trim().optional(),
  avatarUrl: z.url().optional(),
});

export class CreateWorkspaceDto extends createZodDto(CreateWorkspaceSchema) {}

// ── Update Workspace ─────────────────────────────────────────────────────────

export const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(1000).trim().optional(),
  avatarUrl: z.url().optional().nullable(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export class UpdateWorkspaceDto extends createZodDto(UpdateWorkspaceSchema) {}

// ── Add Member ───────────────────────────────────────────────────────────────

export const AddMemberSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().min(1).max(100).optional(),
});

export class AddMemberDto extends createZodDto(AddMemberSchema) {}

// ── Update Member ─────────────────────────────────────────────────────────────

export const UpdateMemberSchema = z.object({
  roleId: z.string().min(1).max(100).optional(),
  status: z.enum(workspaceMemberStatusEnum.enumValues).optional(),
  // When supplied, replaces the user's full set of team memberships (SRS §6.3 / USER-FR-008).
  teamIds: z.array(z.string().uuid()).optional(),
});

export class UpdateMemberDto extends createZodDto(UpdateMemberSchema) {}

// ── Invite Member ─────────────────────────────────────────────────────────────

/**
 * One project + level the invitation grants on acceptance (Settings §6.4, RBE-11).
 *
 * `PROJECT_ACCESS_LEVEL` from the catalogue, not a hand-written enum: this is the fourth place the
 * level set appears (CHECK constraint, `ACCESS_LEVEL_PERMISSIONS`, the SPA mirror), and the week a
 * third level existed and was removed again (migrations 0113, 0115) is what a literal here would
 * have got wrong.
 */
export const InvitationProjectAccessSchema = z.object({
  projectId: z.string().uuid(),
  accessLevel: z.enum(PROJECT_ACCESS_LEVEL),
});

export const InviteMemberSchema = z.object({
  email: z.string().email(),
  roleId: z.string().min(1).max(100).optional(),
  /**
   * Optional, and an empty list is legal — that is the pre-§6.4 behaviour: the invitee lands with
   * no project access and stays No Access until someone grants a level. Making it required would
   * break every existing caller and force a choice on an inviter who has not made one.
   *
   * Deliberately a plain object schema with NO `superRefine`. The duplicate-project rule lives in
   * `WorkspaceService.assertInvitationProjectAccess` instead: wrapping this schema in a refinement
   * makes it a `ZodEffects`, and the committed API client is generated from the OpenAPI document
   * these DTOs produce (`pnpm --filter rally-web codegen` — legacy physical name, do not rename — diffed by the `OpenAPI contract` job) —
   * so a shape change here is a client change, for a rule the service enforces anyway.
   */
  projectAccess: z.array(InvitationProjectAccessSchema).optional(),
});

export class InviteMemberDto extends createZodDto(InviteMemberSchema) {}

// ── Accept Invitation ─────────────────────────────────────────────────────────

export const AcceptInvitationSchema = z.object({
  token: z.string().min(1),
});

export class AcceptInvitationDto extends createZodDto(AcceptInvitationSchema) {}

// ── Workspace Settings ────────────────────────────────────────────────────────

export const UpdateWorkspaceSettingsSchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  defaultLocale: z.string().min(2).max(10).optional(),
  dateFormat: z.string().min(1).max(50).optional(),
});

export class UpdateWorkspaceSettingsDto extends createZodDto(UpdateWorkspaceSettingsSchema) {}
